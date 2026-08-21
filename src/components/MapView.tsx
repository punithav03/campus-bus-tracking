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

export function MapView({ route, bus, myStopId, campus, progress = 0 }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const busMarker = useRef<maplibregl.Marker | null>(null);
  const stopMarkers = useRef<maplibregl.Marker[]>([]);
  const campusMarker = useRef<maplibregl.Marker | null>(null);

  const shown = useRef<{ lng: number; lat: number } | null>(null);
  const target = useRef<{ lng: number; lat: number } | null>(null);
  /** Displayed heading, eased separately so the bus swings rather than snaps. */
  const heading = useRef<number | null>(null);
  const headingTarget = useRef(0);
  const fittedFor = useRef<string | null>(null);
  /** Cancels a half-finished draw animation when another draw starts. */
  const drawToken = useRef(0);
  /** Tears down the watcher for a style swap that has been superseded. */
  const styleWatch = useRef<(() => void) | null>(null);

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
    try {
      drawNow(m, routeRef.current);
      return true;
    } catch {
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
    // Not gated on `ready` (the map's 'load' event) for the same reason
    // drawRoute is not gated on isStyleLoaded: 'load' waits for the first tile
    // render, so a slow tile server left the bus off the map entirely while
    // the route was already drawn. A Marker is a DOM overlay — it needs the
    // map object, nothing more.
    if (!m) return;

    if (!bus) {
      busMarker.current?.remove();
      busMarker.current = null;
      shown.current = null;
      target.current = null;
      return;
    }

    target.current = { lng: bus.lng, lat: bus.lat };
    headingTarget.current = bus.bearing;
    if (heading.current == null) heading.current = bus.bearing;
    if (!busMarker.current) {
      const el = document.createElement('div');
      el.className = 'bus-marker';
      el.innerHTML =
        '<span class="bus-pulse"></span>' +
        '<span class="bus-glyph"><svg viewBox="0 0 24 24" aria-hidden>' +
        // Nose at the top: rotating an emoji would just spin a side-on bus.
        '<path d="M12 2c-3 0-5 1.3-5 3.2v13c0 1 .7 1.8 1.6 1.8h6.8c.9 0 1.6-.8 1.6-1.8v-13C17 3.3 15 2 12 2z" fill="currentColor"/>' +
        '<rect x="8.4" y="4.6" width="7.2" height="4.2" rx="1.4" fill="rgba(255,255,255,.92)"/>' +
        '<rect x="8.6" y="10.4" width="6.8" height="1.5" rx=".75" fill="rgba(255,255,255,.55)"/>' +
        '<circle cx="9.3" cy="18.4" r="1" fill="rgba(255,255,255,.8)"/>' +
        '<circle cx="14.7" cy="18.4" r="1" fill="rgba(255,255,255,.8)"/>' +
        '</svg></span>';
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

      // Take the short way round: 350° to 10° is a 20° nudge, not a 340° spin.
      if (heading.current != null) {
        let delta = ((headingTarget.current - heading.current + 540) % 360) - 180;
        heading.current = (heading.current + delta * 0.14 + 360) % 360;
        // A slight lean into the turn — how much it is still turning, not where.
        const lean = Math.max(-9, Math.min(9, delta * 0.5));
        mk.getElement().style.setProperty('--bearing', heading.current.toFixed(1) + 'deg');
        mk.getElement().style.setProperty('--lean', lean.toFixed(1) + 'deg');
      }
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
