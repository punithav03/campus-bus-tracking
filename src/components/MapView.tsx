'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_FILE, campusStyle, campusMapReachable, registerPmtiles } from '@/lib/basemap';

registerPmtiles(maplibregl);

/**
 * All of these render the SAME OpenStreetMap data — the difference is purely
 * cartography. That matters more than it sounds: OpenFreeMap's dark style draws
 * 47 layers, VersaTiles draws 324, so the same village road that is invisible in
 * one is clearly labelled in the other.
 *
 * `dark` is not cosmetic metadata — the route line, its casing and the markers
 * all pick their colours from it. A slate-grey travelled line is invisible on a
 * pale basemap, and a near-black casing looks like a smear on one.
 */
export const MAP_STYLES = [
  // Ours: served from this app, works offline once opened. See lib/basemap.ts.
  { id: 'svpcet',      label: 'SVPCET map',        url: MAP_FILE, local: true, dark: false },
  { id: 'svpcet-dark', label: 'SVPCET map — dark', url: MAP_FILE, local: true, dark: true },
  { id: 'liberty',   label: 'Liberty',          url: 'https://tiles.openfreemap.org/styles/liberty',                    dark: false },
  { id: 'colorful',  label: 'Colorful',         url: 'https://tiles.versatiles.org/assets/styles/colorful/style.json',  dark: false },
  { id: 'graybeard', label: 'Graybeard — grey', url: 'https://tiles.versatiles.org/assets/styles/graybeard/style.json', dark: false },
  { id: 'neutrino',  label: 'Neutrino — light', url: 'https://tiles.versatiles.org/assets/styles/neutrino/style.json',  dark: false },
  { id: 'eclipse',   label: 'Eclipse — dark',   url: 'https://tiles.versatiles.org/assets/styles/eclipse/style.json',   dark: true },
  { id: 'ofm-dark',  label: 'OpenFreeMap dark', url: 'https://tiles.openfreemap.org/styles/dark',                       dark: true },
] as const;

const DEFAULT_STYLE = 'svpcet';
const styleDef = (id: string) =>
  MAP_STYLES.find((s) => s.id === id) ??
  MAP_STYLES.find((s) => s.id === DEFAULT_STYLE)!;

/**
 * If the tile host is unreachable — campus Wi-Fi during a demo, or no internet
 * at all — the map still has to work. The route, the stops and the bus are OUR
 * geometry, not the basemap's, so a plain canvas keeps everything meaningful.
 */
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0c1119' } }],
};

export interface MapRoute {
  id: string;
  color: string;
  shape: [number, number][];
  stops: { id: string; name: string; lat: number; lng: number; estimated?: boolean }[];
}

export interface MapBus {
  /** Where the bus REALLY is — the matched road position, not a point on the plan. */
  lat: number;
  lng: number;
  bearing: number;
  ghost: boolean;
  /** Progress along the planned route, metres. Used to draw the line ahead. */
  distAlongM: number;
  /** Its speed at that moment, m/s — what we advance it by between readings. */
  speedMps: number;
  /** Only a LIVE bus may be predicted forward. See the animation loop. */
  live: boolean;
  /** On its planned route. Off it, the line ahead is a routed road, not the plan. */
  onRoute: boolean;
}

/** One stretch of the road driven. 'gps' = raw fixes, drawn dashed. */
export interface MapTrailSeg { kind: 'road' | 'gps'; pts: [number, number][] }

export type MapStopState = 'served' | 'skipped' | 'likely-skipped' | 'upcoming';

interface Props {
  route: MapRoute | null;
  bus: MapBus | null;
  myStopId: string | null;
  campus: { lat: number; lng: number; name: string } | null;
  /** The settled trail: the road the bus has actually driven this run. */
  trail?: MapTrailSeg[];
  /** The newest, still-revisable stretch, ending at the bus. */
  tail?: [number, number][];
  /** Off its route: the road from the bus to where it can rejoin. */
  aheadVia?: [number, number][] | null;
  /** Where along the plan the line ahead continues from. */
  aheadFromM?: number | null;
  /** What happened at each stop, by stop id. */
  stopStates?: Record<string, MapStopState>;
}

/**
 * Waits for a style to genuinely be ready.
 *
 * The subtle part is `skipSync`. Right after setStyle() is called the map is
 * still holding the OLD style, so isStyleLoaded() answers `true` — about the
 * previous style. Taking that as a green light draws the route onto a style
 * that is seconds from being thrown away, and when the new one lands it takes
 * the route with it. That is the "line disappears when I switch the map" bug,
 * and it only showed up sometimes because it is a race with the network: a
 * cached style JSON lands fast enough to wipe the line, an uncached one does
 * not. So after a setStyle we refuse the synchronous answer and insist on
 * seeing a fresh styledata event first.
 */
function whenStyleReady(m: MlMap, cb: () => void, skipSync = false) {
  if (!skipSync && m.isStyleLoaded()) { cb(); return () => {}; }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    m.off('styledata', onData);
    clearInterval(poll);
    clearTimeout(giveUp);
    cb();
  };
  const onData = () => { if (m.isStyleLoaded()) finish(); };
  m.on('styledata', onData);
  const poll = setInterval(() => { if (m.isStyleLoaded()) finish(); }, 120);
  const giveUp = setTimeout(finish, 6000);
  return () => {
    done = true;
    clearInterval(poll); clearTimeout(giveUp); m.off('styledata', onData);
  };
}

/**
 * Resolves a basemap to something setStyle can be trusted with.
 *
 * Checking up front is what makes the failure mode honest: either we hand
 * MapLibre a style we have just confirmed is reachable, or we hand it the
 * offline canvas deliberately. There is no third state where the map is blank
 * and nobody knows why.
 */
async function loadStyle(url: string, dark = false): Promise<string | StyleSpecification> {
  if (url === MAP_FILE) return (await campusMapReachable()) ? campusStyle(dark) : OFFLINE_STYLE;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(String(res.status));
    return url;
  } catch {
    return OFFLINE_STYLE;
  }
}

/** Where is "6,910 metres along the road"? Walks the tape and interpolates. */
function pointAt(shape: [number, number][], cum: number[], dist: number) {
  if (!shape.length || cum.length < 2) return null;
  const d = Math.max(0, Math.min(cum[cum.length - 1], dist));
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) {                       // binary search — 453 points, every frame
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid + 1; else hi = mid;
  }
  const span = cum[lo] - cum[lo - 1] || 1;
  const t = (d - cum[lo - 1]) / span;
  const [aLng, aLat] = shape[lo - 1];
  const [bLng, bLat] = shape[lo];
  const lat = aLat + t * (bLat - aLat);
  const lng = aLng + t * (bLng - aLng);
  // Heading from the segment itself: the road knows which way the bus points
  // far better than two noisy GPS fixes do.
  const y = Math.sin((bLng - aLng) * Math.PI / 180) * Math.cos(bLat * Math.PI / 180);
  const x = Math.cos(aLat * Math.PI / 180) * Math.sin(bLat * Math.PI / 180) -
            Math.sin(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
            Math.cos((bLng - aLng) * Math.PI / 180);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { lat, lng, bearing };
}

/** Cumulative metres along a polyline. */
function cumOf(pts: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + metresBetween(pts[i - 1], pts[i]));
  return out;
}

function metresBetween(a: [number, number], b: [number, number]): number {
  const kx = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110574);
}

/** Nearest point on a polyline: distance along it, and how far off it the point is. */
function projectOnPath(
  pts: [number, number][], cum: number[], p: [number, number], fromM = 0, toM = Infinity,
): { d: number; off: number } | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { d: 0, off: metresBetween(pts[0], p) };
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110574;
  let best: { d: number; off: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < fromM || cum[i - 1] > toM) continue;
    const ax = (pts[i - 1][0] - p[0]) * kx, ay = (pts[i - 1][1] - p[1]) * ky;
    const bx = (pts[i][0] - p[0]) * kx, by = (pts[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || off < best.off) best = { d: cum[i - 1] + t * (cum[i] - cum[i - 1]), off };
  }
  return best;
}

/** The plan from `fromM` to `toM`, as points — the line ahead of a bus on its route. */
function planSlice(shape: [number, number][], cum: number[], fromM: number, toM = Infinity): [number, number][] {
  if (shape.length < 2 || cum.length !== shape.length) return [];
  const start = pointAt(shape, cum, fromM);
  if (!start) return [];
  const out: [number, number][] = [[start.lng, start.lat]];
  for (let i = 0; i < shape.length; i++) {
    if (cum[i] > fromM && cum[i] < toM) out.push(shape[i]);
  }
  if (Number.isFinite(toM)) {
    const end = pointAt(shape, cum, toM);
    if (end) out.push([end.lng, end.lat]);
  }
  return out;
}

/** Append points, dropping any that repeat the last one. */
function pushPts(into: [number, number][], pts: [number, number][]) {
  for (const p of pts) {
    const last = into[into.length - 1];
    if (!last || metresBetween(last, p) > 0.5) into.push(p);
  }
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

export function MapView({
  route, bus, myStopId, campus, trail, tail, aheadVia, aheadFromM, stopStates,
}: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const busMarker = useRef<maplibregl.Marker | null>(null);
  const stopMarkers = useRef<maplibregl.Marker[]>([]);
  const campusMarker = useRef<maplibregl.Marker | null>(null);

  /**
   * The road the marker is travelling along: the last stretch the bus
   * actually drove, then the road ahead of it. Rebuilt on every reading.
   * `base` is how far along it the reading itself sits.
   */
  const motion = useRef<{
    path: [number, number][]; cum: number[]; base: number;
    speed: number; at: number; live: boolean;
  } | null>(null);
  /** Metres along `motion.path` we are DRAWING the bus at. */
  const shownDist = useRef<number | null>(null);
  /** Where the marker is drawn right now, so the next path can start from it. */
  const drawnPos = useRef<[number, number] | null>(null);
  /** Identity of the last reading, so a re-render is not mistaken for news. */
  const lastReading = useRef<string | null>(null);
  /** Cumulative metres at each shape vertex — the measuring tape, client side. */
  const cum = useRef<number[]>([]);
  /**
   * Set while the page was in the background, cleared by the next real reading.
   *
   * Coming back to the app was showing the bus somewhere it had never been.
   * While the tab is hidden the browser suspends our animation and the page
   * stops polling, so on return we held a reading minutes old — and the loop
   * cheerfully advanced the bus by its capped 25 seconds of guesswork before
   * the first fresh poll landed and yanked it elsewhere. Two wrong positions in
   * a row. So after an absence we show nothing new until the server has spoken.
   */
  const awaitingFresh = useRef(false);
  /** Displayed heading, eased separately so the bus swings rather than snaps. */
  const heading = useRef<number | null>(null);
  const headingTarget = useRef(0);
  /** Which way the bus body faces: 1 = right, -1 = left. */
  const facing = useRef(1);
  const fittedFor = useRef<string | null>(null);
  /** Cancels a half-finished draw animation when another draw starts. */
  const drawToken = useRef(0);
  /** Tears down the watcher for a style swap that has been superseded. */
  const styleWatch = useRef<(() => void) | null>(null);
  /** What is currently drawn, so a redraw only happens when something changed. */
  const drawnSig = useRef<string | null>(null);

  const [styleId, setStyleId] = useState<string>(DEFAULT_STYLE);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [follow, setFollow] = useState(false);
  /**
   * Navigation view: tilted, turning with the bus, the way a satnav shows the
   * road ahead. Remembered per device; off by default because a flat
   * north-up map is easier to read at a glance from a bus stop.
   */
  const [nav3d, setNav3d] = useState(false);
  const nav3dRef = useRef(false);
  nav3dRef.current = nav3d;
  useEffect(() => {
    try { if (localStorage.getItem('campusbus.nav3d') === '1') setNav3d(true); } catch { /* private mode */ }
  }, []);
  /** Set once the student pans or zooms — after that the camera is theirs. */
  const grabbed = useRef(false);
  /** So we only snap to the bus the first time one appears. */
  const framedBus = useRef(false);
  const [expanded, setExpanded] = useState(false);

  /**
   * On a phone the map is 100dvh tall but the sheet covers the bottom half and
   * the header the top strip. Fitting to the raw container therefore parks the
   * route — and the bus — underneath the sheet, which is why the bus appeared
   * to be missing. Pad the fit by whatever is covering the map.
   */
  const visiblePadding = useCallback(() => {
    if (typeof window === 'undefined') return 60;
    const small = window.matchMedia('(max-width: 939px)').matches;
    if (!small || expanded) return 60;
    return {
      top: 120,
      bottom: Math.round(window.innerHeight * 0.48),
      left: 34,
      right: 34,
    };
  }, [expanded]);

  // Everything drawRoute reads goes through a ref, so drawRoute never changes
  // identity. The /api/network poll hands back a fresh `campus` object every 15
  // seconds; if that leaked into a dependency list the map would be destroyed
  // and rebuilt on every poll, which looks exactly like a map that never loads.
  // The same measuring tape the server uses, rebuilt here so the marker can be
  // placed at an arbitrary distance along the road rather than at a raw point.
  useEffect(() => {
    if (!route) { cum.current = []; return; }
    const R = 6371008.8, rad = (d: number) => (d * Math.PI) / 180;
    const out = [0];
    for (let i = 1; i < route.shape.length; i++) {
      const [aLng, aLat] = route.shape[i - 1];
      const [bLng, bLat] = route.shape[i];
      const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
      const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
      out.push(out[i - 1] + 2 * R * Math.asin(Math.sqrt(h)));
    }
    cum.current = out;
  }, [route]);

  const busRef = useRef(bus);
  busRef.current = bus;
  const routeRef = useRef(route);
  const myStopRef = useRef(myStopId);
  const campusRef = useRef(campus);
  const styleRef = useRef(styleId);
  const trailRef = useRef(trail);
  const tailRef = useRef(tail);
  const viaRef = useRef(aheadVia);
  const aheadFromRef = useRef(aheadFromM);
  const statesRef = useRef(stopStates);
  routeRef.current = route;
  myStopRef.current = myStopId;
  campusRef.current = campus;
  styleRef.current = styleId;
  trailRef.current = trail;
  tailRef.current = tail;
  viaRef.current = aheadVia;
  aheadFromRef.current = aheadFromM;
  statesRef.current = stopStates;

  /**
   * How the PLANNED route looks. With no bus running it is the route, drawn
   * boldly — it is what a student wants to see. Once a bus is running it
   * steps back to a faint reference line, because two other lines now carry
   * the truth: the road actually driven, and the road ahead.
   *
   * That split is the whole point. The old map coloured the plan in behind
   * the bus as "travelled", so a bus that skipped the Nindra spur was shown
   * as having driven it. Now the spur simply stays faint, because nobody
   * drove it.
   */
  const planLook = useCallback(() => {
    const dark = styleDef(styleRef.current).dark;
    return busRef.current
      ? { op: 0.38, w: 3, cas: 0 }
      : { op: 1, w: 5, cas: dark ? 0.6 : 0.9 };
  }, []);

  const paintPlan = useCallback((m: MlMap) => {
    if (!m.getLayer('route-line') || !m.getLayer('route-casing')) return;
    const look = planLook();
    try {
      m.setPaintProperty('route-line', 'line-opacity', look.op);
      m.setPaintProperty('route-line', 'line-width', look.w);
      m.setPaintProperty('route-casing', 'line-opacity', look.cas);
    } catch { /* layer replaced mid-flight */ }
  }, [planLook]);

  /**
   * The two lines that tell the truth: the road behind the bus that it
   * actually drove, and the road ahead of it.
   *
   * Ahead is the plan from where the bus is — or, while it is off its route,
   * the road from the bus to where it can rejoin (dashed: a routed estimate,
   * not a promise), then the plan on from there.
   */
  const paintLive = useCallback((m: MlMap) => {
    const r = routeRef.current;
    const b = busRef.current;
    const tSrc = m.getSource('trail') as maplibregl.GeoJSONSource | undefined;
    const aSrc = m.getSource('ahead') as maplibregl.GeoJSONSource | undefined;
    const vSrc = m.getSource('via') as maplibregl.GeoJSONSource | undefined;
    if (!tSrc || !aSrc || !vSrc) return;

    if (!b || !r) {
      tSrc.setData(EMPTY_FC);
      aSrc.setData(EMPTY_FC);
      vSrc.setData(EMPTY_FC);
      return;
    }

    // ---- behind: the settled trail, then the newest stretch ending at the bus
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = (trailRef.current ?? [])
      .filter((sg) => sg.pts.length >= 2)
      .map((sg) => ({
        type: 'Feature',
        properties: { kind: sg.kind },
        geometry: { type: 'LineString', coordinates: sg.pts },
      }));
    const tl = tailRef.current ?? [];
    if (tl.length >= 2) {
      features.push({
        type: 'Feature', properties: { kind: 'road' },
        geometry: { type: 'LineString', coordinates: tl },
      });
    }
    tSrc.setData({ type: 'FeatureCollection', features });

    // ---- ahead
    const via = viaRef.current;
    const from = aheadFromRef.current ?? b.distAlongM;
    const onward = planSlice(r.shape, cum.current, from);
    aSrc.setData(onward.length >= 2
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: onward } }
      : EMPTY_FC);
    vSrc.setData(!b.onRoute && via && via.length >= 2
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: via } }
      : EMPTY_FC);
  }, []);

  // ---- draw our own geometry ----------------------------------------------
  // Re-run after every style change: setStyle() wipes custom sources & layers.
  const drawNow = useCallback((m: MlMap, r: MapRoute | null) => {
    const token = ++drawToken.current;

    for (const s of stopMarkers.current) s.remove();
    stopMarkers.current = [];
    for (const id of ['via-line', 'ahead-line', 'ahead-casing', 'trail-gps', 'trail-line',
                      'trail-casing', 'route-line', 'route-casing']) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    for (const id of ['via', 'ahead', 'trail', 'route']) if (m.getSource(id)) m.removeSource(id);
    if (!r) return;

    const dark = styleDef(styleRef.current).dark;

    m.addSource('route', {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: r.shape },
      },
    });
    m.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        // A dark halo lifts the line off a dark map; on a pale map it needs a
        // light one instead, or the route reads as a dirty smear.
        'line-color': dark ? '#05070b' : '#ffffff',
        'line-width': 10,
        'line-opacity': dark ? 0.6 : 0.9,
        'line-blur': dark ? 1 : 0,
      },
    });
    m.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': r.color, 'line-width': 5, 'line-opacity': 1 },
    });

    // The road actually driven. Grey, so it reads as "done" against the
    // route colour ahead — the same convention the map always used, now
    // drawn from where the bus really went instead of from the plan.
    const done = dark ? '#7b8aa3' : '#64748b';
    m.addSource('trail', { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: 'trail-casing', type: 'line', source: 'trail',
      filter: ['==', ['get', 'kind'], 'road'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': dark ? '#05070b' : '#ffffff', 'line-width': 9, 'line-opacity': dark ? 0.55 : 0.85 },
    });
    m.addLayer({
      id: 'trail-line', type: 'line', source: 'trail',
      filter: ['==', ['get', 'kind'], 'road'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': done, 'line-width': 4.5 },
    });
    // Raw GPS joined up, where no known road explains the fixes. Dashed,
    // because it is a record of fixes, not a claim about which road.
    m.addLayer({
      id: 'trail-gps', type: 'line', source: 'trail',
      filter: ['==', ['get', 'kind'], 'gps'],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': done, 'line-width': 3, 'line-dasharray': [1.4, 1.6] },
    });

    // The road ahead, in the route's colour.
    m.addSource('ahead', { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: 'ahead-casing', type: 'line', source: 'ahead',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': dark ? '#05070b' : '#ffffff', 'line-width': 10, 'line-opacity': dark ? 0.6 : 0.9 },
    });
    m.addLayer({
      id: 'ahead-line', type: 'line', source: 'ahead',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': r.color, 'line-width': 5 },
    });
    // Off the route: how it gets back. A routed estimate, so dashed.
    m.addSource('via', { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: 'via-line', type: 'line', source: 'via',
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': r.color, 'line-width': 4.5, 'line-dasharray': [1.2, 1.2] },
    });
    paintLive(m);

    // Draw the line on rather than flashing it in.
    //
    // Time-based, not frame-based: requestAnimationFrame is suspended while the
    // tab is hidden, so a frame-counted version that started at opacity 0 and
    // was then backgrounded left the route invisible. And because even a
    // time-based loop needs a frame to run at all, a timer forces the final
    // values regardless. The route being visible is not allowed to depend on
    // an animation completing.
    const DRAW_MS = 620;
    const at = (e: number) => {
      if (!m.getLayer('route-line') || !m.getLayer('route-casing')) return;
      // Grow towards whatever the plan should look like right now — bold with
      // no bus, a faint reference line with one.
      const look = planLook();
      m.setPaintProperty('route-line', 'line-opacity', e * look.op);
      m.setPaintProperty('route-casing', 'line-opacity', e * look.cas);
      m.setPaintProperty('route-line', 'line-width', look.w * (0.4 + 0.6 * e));
      m.setPaintProperty('route-casing', 'line-width', 4 + e * 6);
    };
    const t0 = performance.now();
    const grow = () => {
      if (token !== drawToken.current) return;
      const t = Math.min(1, (performance.now() - t0) / DRAW_MS);
      at(1 - Math.pow(1 - t, 3));
      if (t < 1) requestAnimationFrame(grow);
    };
    at(0);
    requestAnimationFrame(grow);
    setTimeout(() => { if (token === drawToken.current) at(1); }, DRAW_MS + 260);

    r.stops.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'stop-marker';
      el.style.animation = `fadeIn .5s var(--ease) both ${0.2 + i * 0.045}s`;
      el.style.setProperty('--c', r.color);
      el.dataset.mine = String(s.id === myStopRef.current);
      el.dataset.estimated = String(!!s.estimated);
      el.dataset.state = statesRef.current?.[s.id] ?? 'upcoming';
      el.dataset.dark = String(dark);
      el.title = s.estimated ? `${s.name} (position estimated)` : s.name;
      stopMarkers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(m),
      );
    });

    const c = campusRef.current;
    if (c) {
      campusMarker.current?.remove();
      const el = document.createElement('div');
      el.className = 'campus-marker';
      el.dataset.dark = String(dark);
      el.textContent = c.name;
      campusMarker.current = new maplibregl.Marker({ element: el })
        .setLngLat([c.lng, c.lat])
        .addTo(m);
    }
  }, [planLook, paintLive]);

  /**
   * Every entry point goes through here, so the guards live in exactly one place.
   *
   * Deliberately NOT gated on isStyleLoaded(). That looks like the obvious
   * check and it is the wrong one: MapLibre reports a style as loaded only once
   * every source cache has finished fetching its TILES, so on a slow tile
   * server it stays false for many seconds — and on a map that is still
   * fetching as you pan, longer. Our route, stops and bus are our own geometry
   * and owe the basemap nothing, yet gating on that flag made them wait for it.
   * Measured: a map visible at 1.7s with no route on it until 19s.
   *
   * So: just try. addSource/addLayer throw while the style document itself is
   * still parsing, which is a much shorter window, and the reconciler retries
   * a few hundred milliseconds later. Attempting and failing is cheap;
   * waiting for the wrong signal was not.
   */
  const drawRoute = useCallback(() => {
    const m = map.current;
    if (!m) return false;
    const r = routeRef.current;
    const sig = r
      ? `${r.id}|${r.shape.length}|${r.color}|${styleRef.current}|${myStopRef.current}`
      : 'none';
    try {
      // Idempotent, and that is not an optimisation — it is the whole point.
      // styledata fires continuously while tiles stream in, so redrawing on
      // every event meant tearing down and rebuilding the route hundreds of
      // times a second. Each rebuild reset the line to opacity 0 and restarted
      // every marker's fade-in from zero, so the geometry was always THERE and
      // never VISIBLE. Measured: 9,639 marker rebuilds in 10 seconds, every
      // one of them sitting at opacity 0.
      if (drawnSig.current === sig && m.getLayer('route-line') && m.getSource('route')) return true;
      drawNow(m, r);
      drawnSig.current = sig;
      return true;
    } catch {
      drawnSig.current = null;
      return false; // style not ready to accept layers yet — the reconciler retries
    }
  }, [drawNow]);

  // ---- create the map once -------------------------------------------------
  useEffect(() => {
    if (!holder.current || map.current) return;
    let cancelled = false;
    let styleTimer: ReturnType<typeof setTimeout> | null = null;

    // Once per device: a style picked before we had our own map (usually the
    // old default, Liberty) is dropped, so everyone lands on the SVPCET map —
    // it works offline and does not depend on anyone else's tile server.
    try {
      if (localStorage.getItem('campusbus.mapstyle.v') !== '2') {
        localStorage.removeItem('campusbus.mapstyle');
        localStorage.setItem('campusbus.mapstyle.v', '2');
      }
    } catch { /* private mode */ }
    let saved: string | null = null;
    try { saved = localStorage.getItem('campusbus.mapstyle'); } catch { /* private mode */ }
    const initial = styleDef(saved ?? DEFAULT_STYLE);
    if (initial.id !== DEFAULT_STYLE) { setStyleId(initial.id); styleRef.current = initial.id; }

    (async () => {
      // Straight to MapLibre with the URL. Validating it with our own fetch
      // first cost a full round trip before the map could even begin, and
      // time-to-first-map is the number a student actually feels. Reachability
      // is proven by the style arriving, not by asking twice — the watchdog
      // below covers the case where it never does.
      const style: string | StyleSpecification = 'local' in initial ? campusStyle(initial.dark) : initial.url;
      if (cancelled || !holder.current) return;

      const m = new maplibregl.Map({
        container: holder.current,
        style,
        center: [79.67, 13.42],
        zoom: 9.4,
        attributionControl: { compact: true },
        fadeDuration: 120,
      });
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      // 'styledata' is the earliest point the style can accept our layers;
      // 'load' additionally waits for the first tile render, which is later
      // than we need. Draw at the first opportunity and let the reconciler
      // cover any attempt that was still too early.
      let styleArrived = false;
      m.on('styledata', () => { styleArrived = true; drawRoute(); });
      m.on('load', () => { styleArrived = true; setReady(true); drawRoute(); });

      // If the style never turns up — captive portal, blocked host, no data —
      // fall back to the plain canvas so the route is still drawn on something
      // rather than leaving a permanently blank rectangle with no explanation.
      styleTimer = setTimeout(() => {
        if (cancelled || styleArrived) return;
        setOffline(true);
        try { m.setStyle(OFFLINE_STYLE, { diff: false }); } catch { /* torn down */ }
      }, 9000);

      // MapLibre emits `error` for every resource it cannot fetch — a tile at
      // the edge of the viewport, a glyph range for a script no label uses.
      // None of those mean the map is broken, and reacting to them would blank
      // a perfectly good basemap. Swallow them: unhandled, they are just noise
      // in the student's console. Whether a STYLE is reachable is decided by
      // fetching it before we ever hand it to setStyle (see loadStyle).
      m.on('error', () => { /* non-fatal by definition — see comment above */ });
      map.current = m;
    })();

    return () => {
      cancelled = true;
      if (styleTimer) clearTimeout(styleTimer);
      map.current?.remove();
      map.current = null;
    };
  }, [drawRoute]);

  // ---- swap basemap --------------------------------------------------------
  /** Guards against a slow style landing after the user has picked another. */
  const styleReq = useRef(0);

  const changeStyle = async (id: string) => {
    const m = map.current;
    const def = MAP_STYLES.find((s) => s.id === id);
    if (!m || !def) return;
    const req = ++styleReq.current;

    setStyleId(id);
    styleRef.current = id; // drawRoute reads this synchronously, before React re-renders
    try { localStorage.setItem('campusbus.mapstyle', id); } catch { /* private mode */ }

    const resolved = await loadStyle(def.url, def.dark);
    if (req !== styleReq.current || !map.current) return; // superseded mid-fetch
    setOffline(resolved === OFFLINE_STYLE);

    // A second switch while the first is still loading would otherwise leave
    // two watchers running, and the older one draws with the older style's
    // colours the moment ANY style settles.
    styleWatch.current?.();
    // diff:false — these six styles share nothing but their data source, so
    // morphing one into another has no payoff and actively misbehaves: mid-diff
    // MapLibre asks the NEW glyph endpoint for the OLD style's font names
    // (VersaTiles spells it noto_sans_regular, OpenFreeMap spells it Noto Sans
    // Regular), which 404s until it settles. A clean teardown avoids the whole
    // class of problem and makes the wipe deterministic for our redraw.
    m.setStyle(resolved, { diff: false });
    styleWatch.current = whenStyleReady(m, drawRoute, true);
  };

  // Not gated on `ready` either — drawRoute is safe to call at any time now,
  // and waiting would just hand the work to the reconciler a tick later.
  useEffect(() => { drawRoute(); }, [ready, route, myStopId, drawRoute]);

  /**
   * The backstop, and the reason the route can no longer go missing.
   *
   * Every other path here is event-driven, and events are exactly what a style
   * swap makes unreliable — they fire early, they fire for unrelated reasons,
   * and a swap that fails fires nothing useful at all. Rather than trying to
   * predict the right moment, this checks the only thing that actually matters:
   * the style is loaded, we have a route, so is the line ON the map? If not,
   * draw it. Outcome, not lifecycle.
   *
   * Costs one getLayer() call every 700ms, and it is the difference between
   * "usually works" and "works".
   */
  useEffect(() => {
    const iv = setInterval(() => {
      const m = map.current;
      if (!m || !routeRef.current) return;
      try {
        if (!m.getLayer('route-line') || !m.getSource('route')) drawRoute();
      } catch {
        // getLayer itself throws before the style exists; try again next tick.
      }
    }, 400);
    return () => clearInterval(iv);
  }, [drawRoute]);

  // Tear down a pending style watcher when the map goes away.
  useEffect(() => () => { styleWatch.current?.(); }, []);

  // The plan steps back when a bus appears and comes forward when it goes.
  const hasBus = !!bus;
  useEffect(() => {
    const m = map.current;
    if (m) paintPlan(m);
  }, [ready, hasBus, styleId, paintPlan]);

  // Trail and line ahead follow every reading.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    try { paintLive(m); } catch { /* style mid-swap — drawNow repaints */ }
  }, [ready, bus, trail, tail, aheadVia, aheadFromM, route, paintLive]);

  // Stop markers carry what happened there — a skipped stop looks skipped.
  useEffect(() => {
    const r = routeRef.current;
    if (!r) return;
    stopMarkers.current.forEach((mk, i) => {
      const st = r.stops[i];
      if (st) mk.getElement().dataset.state = stopStates?.[st.id] ?? 'upcoming';
    });
  }, [stopStates]);

  /**
   * Frame the BUS when there is one, not the whole line.
   *
   * Fitting all 40 km is right when nothing is running — it shows a student the
   * shape of the route. But with a bus on the road it is the wrong picture
   * entirely: at that scale the entire journey is 700 pixels wide, so a bus
   * doing 30 km/h crosses well under a pixel a second and looks parked. The
   * motion was there all along; nobody could see it.
   *
   * So the first time a bus appears we go to it and follow, the way every ride
   * app does. The moment the student pans or zooms, the camera becomes theirs
   * and we stop moving it — being dragged back to the bus while trying to look
   * at your own stop is worse than never following at all.
   */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !bus || framedBus.current || grabbed.current) return;
    framedBus.current = true;
    setFollow(true);
    m.easeTo({
      center: [bus.lng, bus.lat],
      zoom: Math.max(m.getZoom(), 14.5),
      duration: 1400,
      padding: visiblePadding(),
    });
  }, [ready, bus, visiblePadding]);

  // Once they touch the map it is theirs. Only user gestures count — our own
  // easeTo calls must not switch following off.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const mine = () => { grabbed.current = true; setFollow(false); };
    const gesture = (e: { originalEvent?: unknown }) => { if (e.originalEvent) mine(); };
    m.on('dragstart', mine);
    m.on('zoomstart', gesture);
    m.on('rotatestart', gesture);
    m.on('pitchstart', gesture);
    return () => {
      m.off('dragstart', mine); m.off('zoomstart', gesture);
      m.off('rotatestart', gesture); m.off('pitchstart', gesture);
    };
  }, [ready]);

  // ---- fit to the route ----------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !route || fittedFor.current === route.id) return;
    // A bus outranks the overview: if one is already running when the map opens,
    // the effect above frames it instead.
    if (busRef.current) { fittedFor.current = route.id; return; }
    fittedFor.current = route.id;
    const lngs = route.shape.map((c) => c[0]);
    const lats = route.shape.map((c) => c[1]);
    m.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: visiblePadding(), duration: 1100 },
    );
  }, [ready, route, visiblePadding]);

  // Leaving the app and coming back must not teleport the bus. Freeze on
  // return, poll, and move again once the server has answered.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') awaitingFresh.current = true;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ---- keep the canvas matched to its container ---------------------------
  // MapLibre only watches the WINDOW for resizes, not its own container. When
  // the map goes full screen the window never changes, so without this the
  // canvas keeps its old size and the map appears to shrink inside a big black
  // box. A ResizeObserver catches every size change whatever caused it, which
  // is more reliable than firing timers and hoping they land after the CSS
  // transition.
  useEffect(() => {
    const el = holder.current;
    if (!el || !ready) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => map.current?.resize());
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [ready]);

  // ---- expand / collapse ---------------------------------------------------
  useEffect(() => {
    document.body.style.overflow = expanded ? 'hidden' : '';
    // Belt and braces alongside the observer, and it re-fits the route so the
    // extra space is actually used rather than just revealing more empty map.
    const t = setTimeout(() => {
      const m = map.current;
      const r = routeRef.current;
      m?.resize();
      if (m && r) {
        const lngs = r.shape.map((c) => c[0]);
        const lats = r.shape.map((c) => c[1]);
        m.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: expanded ? 90 : visiblePadding(), duration: 600 },
        );
      }
    }, 320);
    return () => { clearTimeout(t); document.body.style.overflow = ''; };
  }, [expanded, visiblePadding]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // ---- the bus -------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    // Not gated on `ready` (the map's 'load' event) for the same reason
    // drawRoute is not gated on isStyleLoaded: 'load' waits for the first tile
    // render, so a slow tile server left the bus off the map entirely while
    // the route was already drawn. A Marker is a DOM overlay — it needs the
    // map object, nothing more.
    if (!m) return;

    if (!bus) {
      busMarker.current?.remove();
      busMarker.current = null;
      shownDist.current = null;
      motion.current = null;
      drawnPos.current = null;
      lastReading.current = null;
      return;
    }

    // Only a genuinely new reading rebuilds the path, or the "time since"
    // clock resets on every render and the bus never moves between polls.
    const key = `${bus.lat.toFixed(6)},${bus.lng.toFixed(6)},${bus.live},${bus.onRoute}`;
    if (key !== lastReading.current) {
      lastReading.current = key;
      const P: [number, number] = [bus.lng, bus.lat];

      // The road the marker will travel: the stretch the bus has just driven
      // (so a marker that is behind catches up ALONG THE ROAD, round the
      // bend, instead of cutting the corner), the reading itself, and then
      // the road ahead (so between readings it rolls on along real tarmac).
      const pts: [number, number][] = [];
      pushPts(pts, tailRef.current ?? []);
      pushPts(pts, [P]);
      const baseIdx = pts.length - 1;

      const r = routeRef.current;
      if (bus.onRoute && r && cum.current.length === r.shape.length) {
        // Join the plan where the bus actually is, not at the smoothed
        // progress figure, which trails it by a few metres — joining there
        // would send the marker backwards for a moment on every reading.
        const near = projectOnPath(r.shape, cum.current, P,
          bus.distAlongM - 150, bus.distAlongM + 400);
        const from = near && near.off < 60 ? near.d : bus.distAlongM;
        pushPts(pts, planSlice(r.shape, cum.current, from, from + 2500));
      } else if (!bus.onRoute && viaRef.current?.length) {
        pushPts(pts, viaRef.current);
      }

      let pc = cumOf(pts);
      let base = pc[baseIdx] ?? 0;
      let start = base;
      const old = drawnPos.current;
      if (old) {
        const pr = projectOnPath(pts, pc, old);
        if (pr && pr.off <= 40) {
          start = pr.d;                              // already on this road
        } else if (metresBetween(old, P) < 250) {
          pts.unshift(old);                          // a short glide across
          pc = cumOf(pts);
          base = pc[baseIdx + 1];
          start = 0;
        }
        // Otherwise: a big jump — it was hidden, or came back from a dead
        // zone. Be right immediately rather than slide across fields.
      }
      motion.current = { path: pts, cum: pc, base, speed: bus.speedMps, at: Date.now(), live: bus.live };
      shownDist.current = start;
      // A genuinely fresh reading — we are allowed to move again.
      awaitingFresh.current = false;
    }
    if (heading.current == null) heading.current = bus.bearing;
    if (!busMarker.current) {
      const el = document.createElement('div');
      el.className = 'bus-marker';
      // A bus seen from the SIDE, kept upright, because that is the only view
      // that still reads as a bus. The previous version was drawn from above
      // and rotated to the heading, which turned it into an unrecognisable
      // blob — and a side-on bus rotated to 270 degrees would simply be upside
      // down. Direction lives on a separate pointer instead, and the bus body
      // flips to face the way it is travelling.
      el.innerHTML =
        '<span class="bus-pulse"></span>' +
        '<span class="bus-cone"></span>' +
        '<span class="bus-glyph"><svg viewBox="0 0 32 20" aria-hidden>' +
        '<g fill="#16305B">' +
        '<circle cx="9" cy="15.4" r="2.7"/>' +
        '<circle cx="23" cy="15.4" r="2.7"/>' +
        '<rect x="1.5" y="2" width="29" height="12.8" rx="3.4"/>' +
        '</g>' +
        // windows: three down the side, then the windscreen at the front
        '<g fill="#FFFFFF">' +
        '<rect x="4.2"  y="4.5" width="5.4" height="4.9" rx="1.2"/>' +
        '<rect x="10.8" y="4.5" width="5.4" height="4.9" rx="1.2"/>' +
        '<rect x="17.4" y="4.5" width="5.4" height="4.9" rx="1.2"/>' +
        '<path d="M24.6 4.5h2.4a1.9 1.9 0 0 1 1.9 1.9v3h-4.3z" opacity=".95"/>' +
        '</g>' +
        // headlight + door line, the details that sell it at 30px
        '<rect x="27.6" y="11.2" width="2.4" height="1.9" rx=".9" fill="#F5B301"/>' +
        '<rect x="13.9" y="10.4" width="1" height="3.4" rx=".5" fill="#FFFFFF" opacity=".45"/>' +
        '</svg></span>';
      busMarker.current = new maplibregl.Marker({ element: el })
        .setLngLat([bus.lng, bus.lat])
        .addTo(m);
      drawnPos.current = [bus.lng, bus.lat];
      // The animation loop takes over from here and works in metres along
      // the motion path, so there is no separate position to seed.
    }
    const el = busMarker.current.getElement();
    el.style.setProperty('--c', route?.color ?? '#f97316');
    el.dataset.ghost = String(bus.ghost);
  }, [ready, bus, route?.color, styleId]);

  /**
   * Keeps the bus MOVING, not stepping.
   *
   * The server is polled every couple of seconds. Easing straight to each new
   * point meant the marker darted to the reading in a third of a second and
   * then sat perfectly still until the next one — move, freeze, move, freeze.
   * That is what made it look dead.
   *
   * So between readings we carry the bus forward ourselves, at the speed it
   * was last doing, along the road it is ACTUALLY on: the matched road behind
   * it and the road ahead of it — the plan if it is on its route, the routed
   * road back if it is not. It used to be carried along the plan regardless,
   * which drew a bus that had skipped a spur gliding down the spur. Each new
   * reading corrects the guess rather than replacing it, so motion never jumps.
   *
   * Two limits, and both are about not lying:
   *   · prediction stops the moment the signal is no longer live. A bus we have
   *     lost must sit still, not keep gliding confidently down the road.
   *   · it never runs more than PREDICT_CAP_S ahead of a real reading. Past
   *     that we are inventing a journey, and a frozen marker is the honest
   *     picture.
   */
  useEffect(() => {
    let raf = 0;
    let ticks = 0;
    let last = performance.now();

    const PREDICT_CAP_S = 25;   // stop guessing beyond this
    const CATCH_UP = 0.06;      // how fast the drawn bus closes on the truth

    const step = () => {
      raf = requestAnimationFrame(step);
      const mk = busMarker.current;
      const m = map.current;
      const f = motion.current;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!mk || !f || f.path.length === 0) return;
      if (f.path.length === 1) {
        mk.setLngLat(f.path[0]);
        drawnPos.current = f.path[0];
        return;
      }
      const total = f.cum[f.cum.length - 1];

      // Where the bus most likely is RIGHT NOW.
      const sinceS = Math.min(PREDICT_CAP_S, (Date.now() - f.at) / 1000);
      const predict = f.live && !awaitingFresh.current;
      const wanted = Math.min(total, predict ? f.base + f.speed * sinceS : f.base);

      if (shownDist.current == null) shownDist.current = wanted;
      const gap = wanted - shownDist.current;

      // Close the gap smoothly, but never crawl backwards on a small negative
      // correction — a bus that visibly reverses reads as a glitch, and the
      // engine already refuses genuine backward jumps.
      // A big gap means the bus is genuinely somewhere else — it was hidden
      // behind another app, or the signal came back after a dead zone. Sliding
      // the marker over is worse than moving it: for several seconds it draws
      // the bus on road it was never on. Jump, and be right immediately.
      if (Math.abs(gap) > 250) {
        shownDist.current = wanted;
      } else if (gap > 0.5 || gap < -25) {
        shownDist.current += gap * (1 - Math.pow(1 - CATCH_UP, dt * 60));
      } else if (predict) {
        shownDist.current += f.speed * dt;   // keep rolling while we are ahead
      }
      shownDist.current = Math.max(0, Math.min(total, shownDist.current));

      const p = pointAt(f.path, f.cum, shownDist.current);
      if (!p) return;
      mk.setLngLat([p.lng, p.lat]);
      drawnPos.current = [p.lng, p.lat];

      // Heading comes from the ROAD under the marker, which is steadier than
      // differencing two noisy fixes, and is what the bus is doing anyway.
      if (heading.current == null) heading.current = p.bearing;
      const delta = ((p.bearing - heading.current + 540) % 360) - 180;
      heading.current = (heading.current + delta * 0.12 + 360) % 360;

      // Face the way we are going. The dead bands around due north and due
      // south are deliberate: without them a bus heading almost exactly north
      // flips back and forth every time the bearing jitters across 360.

      // The pointer and the side-on bus are drawn on the SCREEN, so they need
      // the heading relative to however the map itself is turned.
      const screenH = (heading.current - (m?.getBearing() ?? 0) + 720) % 360;
      if (screenH > 12 && screenH < 168) facing.current = 1;
      else if (screenH > 192 && screenH < 348) facing.current = -1;

      const el = mk.getElement();
      el.style.setProperty('--bearing', screenH.toFixed(1) + 'deg');
      el.style.setProperty('--flip', String(facing.current));
      // Lets the CSS calm the marker down when we are no longer sure.
      el.dataset.predicted = !f.live || sinceS > 6 ? 'true' : 'false';

      // Move the camera every frame rather than easing to it twice a second.
      // Our position is already smooth, so the map glides with the bus instead
      // of lurching after it — and easeTo firing on a timer fought the marker's
      // own animation, which is a large part of why this felt jerky.
      // Not while the map is already animating. setCenter cancels an easeTo in
      // flight, and that silently ate the zoom-in when the bus first appeared —
      // the camera dutifully followed, at a zoom where the whole 40 km fits the
      // screen and the bus crawls one pixel a second. It looked exactly like
      // the bug this was meant to fix.
      if (follow && m && !grabbed.current && !m.isEasing()) {
        ticks++;
        // In the navigation view the map turns with the bus, from the same
        // smoothed heading as the pointer, so the road ahead stays "up".
        if (nav3dRef.current) m.jumpTo({ center: [p.lng, p.lat], bearing: heading.current });
        else m.setCenter([p.lng, p.lat]);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ready, follow, visiblePadding]);

  const dark = styleDef(styleId).dark;

  return (
    <div className="map-wrap" data-expanded={expanded} data-dark={dark}>
      <div ref={holder} style={{ position: 'absolute', inset: 0 }} />

      <button
        className="map-expand"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Exit full screen (Esc)' : 'Expand map'}
        aria-label={expanded ? 'Exit full screen' : 'Expand map'}
      >
        {expanded ? '⤡ Minimise' : '⤢ Expand'}
      </button>

      <div className="map-controls">
        <select
          className="map-style"
          value={styleId}
          onChange={(e) => void changeStyle(e.target.value)}
          aria-label="Basemap style"
        >
          {MAP_STYLES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <button
          className="map-follow"
          data-on={follow}
          onClick={() => {
            const m = map.current;
            const on = !follow;
            if (on && m && drawnPos.current) {
              // Taking the camera back: whatever the student did to the map
              // before, following now means following.
              grabbed.current = false;
              m.easeTo({
                center: drawnPos.current,
                zoom: Math.max(m.getZoom(), nav3d ? 16 : 14.5),
                pitch: nav3d ? 55 : 0,
                bearing: nav3d ? heading.current ?? 0 : 0,
                padding: visiblePadding(),
                duration: 900,
              });
            }
            setFollow(on);
          }}
          disabled={!bus}
          title={bus ? 'Keep the camera on the bus' : 'No bus running'}
        >
          {follow ? '◉ Following' : '◎ Follow bus'}
        </button>
        <button
          className="map-follow"
          data-on={nav3d}
          onClick={() => {
            const m = map.current;
            const on = !nav3d;
            setNav3d(on);
            try { localStorage.setItem('campusbus.nav3d', on ? '1' : '0'); } catch { /* private mode */ }
            if (!m) return;
            if (on && drawnPos.current) {
              grabbed.current = false;
              setFollow(true);
              m.easeTo({
                center: drawnPos.current, zoom: Math.max(m.getZoom(), 16), pitch: 55,
                bearing: heading.current ?? 0, padding: visiblePadding(), duration: 1100,
              });
            } else {
              m.easeTo({ pitch: 0, bearing: 0, duration: 800 });
            }
          }}
          title="Tilted view that turns with the bus"
        >
          3D
        </button>
      </div>

      {offline && (
        <div className="map-offline">
          Basemap offline — route, stops and bus drawn from local data
        </div>
      )}
    </div>
  );
}
