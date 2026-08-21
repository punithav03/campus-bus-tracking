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

export interface MapBus { lat: number; lng: number; bearing: number; ghost: boolean }

interface Props {
  route: MapRoute | null;
  bus: MapBus | null;
  myStopId: string | null;
  campus: { lat: number; lng: number; name: string } | null;
  /** 0-1 along the route — dims the part already driven. */
  progress?: number;
}

/**
 * `styledata` fires several times while a style loads, and the first firing is
 * usually too early — isStyleLoaded() is still false, so anything drawn then is
 * silently dropped. That is why the route vanished when switching basemaps.
 * Wait for the style to genuinely be ready, with a polling backstop in case the
 * event we want never arrives.
 */
function whenStyleReady(m: MlMap, cb: () => void) {
  if (m.isStyleLoaded()) { cb(); return () => {}; }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    m.off('styledata', onData);
    clearInterval(poll);
    cb();
  };
  const onData = () => { if (m.isStyleLoaded()) finish(); };
  m.on('styledata', onData);
  const poll = setInterval(() => { if (m.isStyleLoaded()) finish(); }, 120);
  const giveUp = setTimeout(finish, 6000);
  return () => { clearInterval(poll); clearTimeout(giveUp); m.off('styledata', onData); };
}

export function MapView({ route, bus, myStopId, campus, progress = 0 }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const busMarker = useRef<maplibregl.Marker | null>(null);
  const stopMarkers = useRef<maplibregl.Marker[]>([]);
  const campusMarker = useRef<maplibregl.Marker | null>(null);

  const shown = useRef<{ lng: number; lat: number } | null>(null);
  const target = useRef<{ lng: number; lat: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  /** Cancels a half-finished draw animation when another draw starts. */
  const drawToken = useRef(0);

  const [styleId, setStyleId] = useState<string>(DEFAULT_STYLE);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [follow, setFollow] = useState(false);
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
  const drawRoute = useCallback(() => {
    const m = map.current;
    const r = routeRef.current;
    if (!m || !m.isStyleLoaded()) return;

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
    let t = 0;
    const grow = () => {
      if (token !== drawToken.current || !m.getLayer('route-line')) return;
      t = Math.min(1, t + 0.04);
      const eased = 1 - Math.pow(1 - t, 3);
      m.setPaintProperty('route-line', 'line-opacity', eased);
      m.setPaintProperty('route-casing', 'line-opacity', eased * (dark ? 0.6 : 0.9));
      m.setPaintProperty('route-line', 'line-width', 2 + eased * 3);
      m.setPaintProperty('route-casing', 'line-width', 4 + eased * 6);
      if (t < 1) requestAnimationFrame(grow);
    };
    m.setPaintProperty('route-line', 'line-opacity', 0);
    requestAnimationFrame(grow);

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

  // ---- create the map once -------------------------------------------------
  useEffect(() => {
    if (!holder.current || map.current) return;
    let cancelled = false;

    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('campusbus.mapstyle') : null;
    const initial = styleDef(saved ?? DEFAULT_STYLE);
    if (initial.id !== DEFAULT_STYLE) { setStyleId(initial.id); styleRef.current = initial.id; }

    (async () => {
      let style: string | StyleSpecification = initial.url;
      try {
        const res = await fetch(initial.url, { signal: AbortSignal.timeout(7000) });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        style = OFFLINE_STYLE;
        if (!cancelled) setOffline(true);
      }
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
      m.on('load', () => { setReady(true); drawRoute(); });
      map.current = m;
    })();

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, [drawRoute]);

  // ---- swap basemap --------------------------------------------------------
  const changeStyle = (id: string) => {
    const m = map.current;
    const def = MAP_STYLES.find((s) => s.id === id);
    if (!m || !def) return;
    setStyleId(id);
    styleRef.current = id; // drawRoute reads this synchronously, before React re-renders
    localStorage.setItem('campusbus.mapstyle', id);
    m.setStyle(def.url);
    whenStyleReady(m, drawRoute);
  };

  useEffect(() => { if (ready) drawRoute(); }, [ready, route, myStopId, drawRoute]);

  useEffect(() => {
    const m = map.current;
    if (m && ready) paintGradient(m);
  }, [ready, progress, styleId, paintGradient]);

  // ---- fit to the route ----------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !route || fittedFor.current === route.id) return;
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
    if (!m || !ready) return;

    if (!bus) {
      busMarker.current?.remove();
      busMarker.current = null;
      shown.current = null;
      target.current = null;
      return;
    }

    target.current = { lng: bus.lng, lat: bus.lat };
    if (!busMarker.current) {
      const el = document.createElement('div');
      el.className = 'bus-marker';
      el.innerHTML = '<span class="bus-pulse"></span><span class="bus-glyph">🚌</span>';
      busMarker.current = new maplibregl.Marker({ element: el })
        .setLngLat([bus.lng, bus.lat])
        .addTo(m);
      shown.current = { lng: bus.lng, lat: bus.lat };
    }
    const el = busMarker.current.getElement();
    el.style.setProperty('--c', route?.color ?? '#f97316');
    el.dataset.ghost = String(bus.ghost);
  }, [ready, bus, route?.color, styleId]);

  // Ease the marker toward each new fix, and optionally keep the camera on it.
  useEffect(() => {
    let raf = 0;
    let ticks = 0;
    const step = () => {
      raf = requestAnimationFrame(step);
      const mk = busMarker.current;
      const m = map.current;
      if (!mk || !target.current) return;
      const cur = shown.current ?? target.current;
      const next = {
        lng: cur.lng + (target.current.lng - cur.lng) * 0.12,
        lat: cur.lat + (target.current.lat - cur.lat) * 0.12,
      };
      shown.current = next;
      mk.setLngLat([next.lng, next.lat]);
      if (follow && m && ++ticks % 30 === 0) {
        m.easeTo({ center: [next.lng, next.lat], duration: 900, padding: visiblePadding() });
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
          onChange={(e) => changeStyle(e.target.value)}
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
