'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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
  { id: 'liberty',   label: 'Liberty',          url: 'https://tiles.openfreemap.org/styles/liberty',                    dark: false },
  { id: 'colorful',  label: 'Colorful',         url: 'https://tiles.versatiles.org/assets/styles/colorful/style.json',  dark: false },
  { id: 'graybeard', label: 'Graybeard — grey', url: 'https://tiles.versatiles.org/assets/styles/graybeard/style.json', dark: false },
  { id: 'neutrino',  label: 'Neutrino — light', url: 'https://tiles.versatiles.org/assets/styles/neutrino/style.json',  dark: false },
  { id: 'eclipse',   label: 'Eclipse — dark',   url: 'https://tiles.versatiles.org/assets/styles/eclipse/style.json',   dark: true },
  { id: 'ofm-dark',  label: 'OpenFreeMap dark', url: 'https://tiles.openfreemap.org/styles/dark',                       dark: true },
] as const;

const DEFAULT_STYLE = 'liberty';
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
  lat: number;
  lng: number;
  bearing: number;
  ghost: boolean;
  /** How far along the route the server last saw it, in metres. */
  distAlongM: number;
  /** Its speed at that moment, m/s — what we advance it by between readings. */
  speedMps: number;
  /** Only a LIVE bus may be predicted forward. See the animation loop. */
  live: boolean;
}

interface Props {
  route: MapRoute | null;
  bus: MapBus | null;
  myStopId: string | null;
  campus: { lat: number; lng: number; name: string } | null;
  /** 0-1 along the route — dims the part already driven. */
  progress?: number;
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
async function loadStyle(url: string): Promise<string | StyleSpecification> {
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

export function MapView({ route, bus, myStopId, campus, progress = 0 }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const busMarker = useRef<maplibregl.Marker | null>(null);
  const stopMarkers = useRef<maplibregl.Marker[]>([]);
  const campusMarker = useRef<maplibregl.Marker | null>(null);

  /** Metres along the route we are DRAWING the bus at. */
  const shownDist = useRef<number | null>(null);
  /** The last reading from the server, and when it landed. */
  const fix = useRef<{ dist: number; speed: number; at: number; live: boolean } | null>(null);
  /** Cumulative metres at each shape vertex — the measuring tape, client side. */
  const cum = useRef<number[]>([]);
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
  const progressRef = useRef(progress);
  routeRef.current = route;
  myStopRef.current = myStopId;
  campusRef.current = campus;
  styleRef.current = styleId;
  progressRef.current = progress;

  /** Travelled/remaining gradient, in colours that survive the current basemap. */
  const paintGradient = useCallback((m: MlMap) => {
    const r = routeRef.current;
    if (!r || !m.getLayer('route-line')) return;
    const dark = styleDef(styleRef.current).dark;
    const done = dark ? '#46536a' : '#94a3b8';
    const p = Math.min(0.999, Math.max(0.001, progressRef.current));
    try {
      m.setPaintProperty('route-line', 'line-gradient', [
        'interpolate', ['linear'], ['line-progress'],
        0, done, p - 0.0008, done, p, r.color, 1, r.color,
      ]);
    } catch { /* layer replaced mid-flight */ }
  }, []);

  // ---- draw our own geometry ----------------------------------------------
  // Re-run after every style change: setStyle() wipes custom sources & layers.
  const drawNow = useCallback((m: MlMap, r: MapRoute | null) => {
    const token = ++drawToken.current;

    for (const s of stopMarkers.current) s.remove();
    stopMarkers.current = [];
    for (const id of ['route-line', 'route-casing']) if (m.getLayer(id)) m.removeLayer(id);
    if (m.getSource('route')) m.removeSource('route');
    if (!r) return;

    const dark = styleDef(styleRef.current).dark;

    m.addSource('route', {
      type: 'geojson',
      lineMetrics: true, // required for the travelled/remaining gradient
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
    paintGradient(m);

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
      m.setPaintProperty('route-line', 'line-opacity', e);
      m.setPaintProperty('route-casing', 'line-opacity', e * (dark ? 0.6 : 0.9));
      m.setPaintProperty('route-line', 'line-width', 2 + e * 3);
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
  }, [paintGradient]);

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

    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('campusbus.mapstyle') : null;
    const initial = styleDef(saved ?? DEFAULT_STYLE);
    if (initial.id !== DEFAULT_STYLE) { setStyleId(initial.id); styleRef.current = initial.id; }

    (async () => {
      // Straight to MapLibre with the URL. Validating it with our own fetch
      // first cost a full round trip before the map could even begin, and
      // time-to-first-map is the number a student actually feels. Reachability
      // is proven by the style arriving, not by asking twice — the watchdog
      // below covers the case where it never does.
      const style: string | StyleSpecification = initial.url;
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

    const resolved = await loadStyle(def.url);
    if (req !== styleReq.current || !map.current) return; // superseded mid-fetch
    setOffline(resolved !== def.url);

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

  useEffect(() => {
    const m = map.current;
    if (m && ready) paintGradient(m);
  }, [ready, progress, styleId, paintGradient]);

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
    m.on('dragstart', mine);
    m.on('zoomstart', (e: { originalEvent?: unknown }) => { if (e.originalEvent) mine(); });
    return () => { m.off('dragstart', mine); };
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
      fix.current = null;
      return;
    }

    // Only record a genuinely new reading, or the "time since" clock resets on
    // every render and the bus never gets to move between polls.
    if (!fix.current || fix.current.dist !== bus.distAlongM || fix.current.live !== bus.live) {
      fix.current = { dist: bus.distAlongM, speed: bus.speedMps, at: Date.now(), live: bus.live };
      if (shownDist.current == null) shownDist.current = bus.distAlongM;
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
      // The animation loop takes over from here and works in metres along the
      // route, not raw points, so there is no separate position to seed.
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
   * So between readings we carry the bus forward ourselves, along the route, at
   * the speed it was last doing. We can do this honestly because we know the
   * road: the bus is not drifting across a field toward a guessed point, it is
   * following the same tarmac it is actually on. Each new reading then corrects
   * the guess rather than replacing it, so the motion never jumps.
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
      const r = routeRef.current;
      const f = fix.current;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!mk || !f || !r || cum.current.length < 2) return;

      // Where the bus most likely is RIGHT NOW.
      const sinceS = Math.min(PREDICT_CAP_S, (Date.now() - f.at) / 1000);
      const wanted = f.live ? f.dist + f.speed * sinceS : f.dist;

      if (shownDist.current == null) shownDist.current = wanted;
      const gap = wanted - shownDist.current;

      // Close the gap smoothly, but never crawl backwards on a small negative
      // correction — a bus that visibly reverses reads as a glitch, and the
      // engine already refuses genuine backward jumps.
      if (gap > 0.5 || gap < -25) {
        shownDist.current += gap * (1 - Math.pow(1 - CATCH_UP, dt * 60));
      } else if (f.live) {
        shownDist.current += f.speed * dt;   // keep rolling while we are ahead
      }

      const p = pointAt(r.shape, cum.current, shownDist.current);
      if (!p) return;
      mk.setLngLat([p.lng, p.lat]);

      // Heading comes from the ROAD, which is steadier than differencing two
      // noisy fixes, and it is what the bus is physically doing anyway.
      if (heading.current == null) heading.current = p.bearing;
      const delta = ((p.bearing - heading.current + 540) % 360) - 180;
      heading.current = (heading.current + delta * 0.12 + 360) % 360;

      // Face the way we are going. The dead bands around due north and due
      // south are deliberate: without them a bus heading almost exactly north
      // flips back and forth every time the bearing jitters across 360.
      const h = heading.current;
      if (h > 12 && h < 168) facing.current = 1;
      else if (h > 192 && h < 348) facing.current = -1;

      const el = mk.getElement();
      el.style.setProperty('--bearing', heading.current.toFixed(1) + 'deg');
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
        m.setCenter([p.lng, p.lat]);
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
          onClick={() => setFollow((f) => !f)}
          disabled={!bus}
          title={bus ? 'Keep the camera on the bus' : 'No bus running'}
        >
          {follow ? '◉ Following' : '◎ Follow bus'}
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
