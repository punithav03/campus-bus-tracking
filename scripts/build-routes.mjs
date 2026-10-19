#!/usr/bin/env node
/**
 * Builds every bus route from the transport office's timing sheet.
 *
 *   npm run routes                      all buses
 *   npm run routes -- tirupati          just one
 *   npm run routes -- --osm D:\osm      roads/places from somewhere else
 *
 * Inputs
 *   data/official/transport.json   the office's 9 buses, stops in order, times
 *                                  (tools/import_official.py writes it)
 *   data/official/stop-hints.json  hand-checked pins for stops OSM cannot find
 *   data/traces/*                  recorded rides: <bus>-*.gpx or .json
 *   <osm>/roads.json, places.json  tools/osm_extract.py writes them
 *   data/private/students.json     optional: pickup points to look for on the road
 *
 * Outputs
 *   data/routes/<bus>.json         what the engine reads: road line, stops, times
 *   data/roads/<bus>.roads.json    the roads around it, for live road matching
 *   data/network.json              the list of routes
 *   data/official/build-report.md  every decision, for a human to check
 *
 * HOW A STOP IS PLACED
 *
 *   1. A hint, if there is one (stop-hints.json).
 *   2. Otherwise OpenStreetMap places whose name matches, spelling-proofed
 *      ("Pichchatur" = "Pichatoor" = "PICHATTUR"). Most names have several
 *      matches across the district; the one chosen is the one that makes the
 *      whole route make sense — each stop reachable from the last in the time
 *      the sheet allows — solved over the whole route at once (Viterbi), not
 *      stop by stop.
 *   3. Otherwise it is placed along the road between its neighbours in
 *      proportion to the times on the sheet, and marked approximate.
 *
 * HOW THE ROAD IS DRAWN
 *
 * Stop to stop over the real road network, with speeds for a bus, so it keeps
 * to main roads. Where a ride has been recorded, roads the bus was seen on are
 * strongly preferred, so the line follows what the bus actually does rather
 * than what a router thinks is quickest. A village beside the main road is
 * served from the main road (the stop is where the road meets the village); a
 * village the bus must turn into is driven into.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CLASSES, loadRegion, snap, busRoute, nearSegments, haversine, simplify, dedupe,
  cumulative, projectOnLine, atDistance, nameKey, jw, polylineLength,
} from './lib/region.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const osmIdx = args.indexOf('--osm');
const OSM = osmIdx >= 0 ? args[osmIdx + 1] : (process.env.OSM_DIR || 'C:/Users/yokes/osm-data');
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--osm');

const CAMPUS = { name: 'SVPCET', lat: 13.433591, lng: 79.509652 };
const COLORS = {
  chittoor: '#e11d48', penumur: '#a855f7', chandragiri: '#22c55e', srikalahasti: '#eab308',
  nagalapuram: '#f97316', vijayapuram: '#06b6d4', tirupati: '#3b82f6', sathrawada: '#ec4899',
  'kvb-puram': '#84cc16',
};

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const transport = read(join(ROOT, 'data/official/transport.json'));
const hints = read(join(ROOT, 'data/official/stop-hints.json'));
const studentsPath = join(ROOT, 'data/private/students.json');
const students = existsSync(studentsPath) ? read(studentsPath).students : [];

console.log(`roads + places from ${OSM}`);
const t0 = Date.now();
const G = loadRegion(join(OSM, 'roads.json'));
const PLACES = read(join(OSM, 'places.json'));
// Road names, for pickups called after a road ("KT Road").
const ROAD_NAMES = JSON.parse(readFileSync(join(OSM, 'roads.json'), 'utf8'))
  .filter((w) => w.name).map((w) => ({ id: w.id, name: w.name, key: nameKey(w.name, true) }));
const NAME_KEYS = ['name', 'name:en', 'alt_name', 'old_name', 'official_name', 'short_name', 'loc_name'];
for (const p of PLACES) {
  const names = NAME_KEYS.map((k) => p[k]).filter(Boolean);
  p.keys = [...new Set(names.map((n) => nameKey(n)))];
  p.fkeys = [...new Set(names.map((n) => nameKey(n, true)))];
}
console.log(`  ${G.n.toLocaleString()} road nodes, ${G.m.toLocaleString()} segments, ${PLACES.length} places (${Date.now() - t0} ms)`);

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const title = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/\b(Mr|Dr|Tmc|Kvb|Rkvb|Rkm|Tkm|Sr|Gd|Bg|Vkr|Tk|Rk)\b/gi, (w) => w.toUpperCase())
  .replace(/\bIskon\b/i, 'ISKCON').replace(/\bMuncipal\b/i, 'Municipal');
const isCollege = (name) => /^COLLEGE$/i.test(name.trim());

// ------------------------------------------------------------------ traces

function loadTraces(bus) {
  const dir = join(ROOT, 'data/traces');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(bus + '-')) continue;
    const s = readFileSync(join(dir, f), 'utf8');
    let pts = [];
    if (f.endsWith('.gpx')) {
      const re = /<trkpt lat="([-\d.]+)" lon="([-\d.]+)">[\s\S]*?<time>([^<]+)<\/time>/g;
      let m;
      while ((m = re.exec(s))) pts.push({ t: Date.parse(m[3]) / 1000, lat: +m[1], lng: +m[2] });
    } else {
      pts = JSON.parse(s).points.map(([t, lat, lng]) => ({ t, lat, lng }));
    }
    out.push({ file: f, pts });
  }
  return out;
}

/** Segment ids the recorded bus drove along: both ends within 30 m of a fix, fixes dense. */
function traceSegments(traces) {
  const near = new Set();
  for (const tr of traces) {
    for (let i = 0; i < tr.pts.length; i++) {
      const p = tr.pts[i];
      // A fix after a long gap says nothing about the road before it.
      for (const f of nearSegments(G, p.lng, p.lat, 30)) near.add(f.s);
    }
  }
  return near;
}

function minDistToTrace(traces, lat, lng) {
  let best = Infinity;
  for (const tr of traces) for (const p of tr.pts) {
    if (Math.abs(p.lat - lat) > 0.03 || Math.abs(p.lng - lng) > 0.03) continue;
    const d = haversine(lat, lng, p.lat, p.lng);
    if (d < best) best = d;
  }
  return best;
}

// --------------------------------------------------------------- geocoding

const KIND_W = (k) => (/^place=(village|town|city|suburb|hamlet|neighbourhood|quarter|locality)/.test(k) ? 0
  : /bus_stop|bus_station/.test(k) ? 0.15
  : /junction|railway=(station|halt)/.test(k) ? -0.1
  : -0.6);

/**
 * OSM places whose name could be this one. `full` compares whole names
 * ("Balaji Colony" is not "Balaji Hospital"); the default compares the name
 * with words like Colony / Circle / Bus Stop taken off, which is right for the
 * office's sheet ("Pichatur Bypass" is at Pichatur).
 */
function candidatesFor(name, full = false) {
  const k = nameKey(name), fk = nameKey(name, true);
  if ((full ? fk : k).length < 3) return [];
  const out = [];
  for (const p of PLACES) {
    let sc = 0;
    if (full) {
      // "IS MAHAL" is the start of "I.S.MAHAL THEATRE, NEHRU NAGAR"; "CRIME
      // POLICE STATION" is inside "TIRUPATI CRIME POLICE STATION".
      for (const x of p.fkeys) {
        sc = Math.max(sc, jw(fk, x),
          x.length >= 6 && x.startsWith(fk) ? 0.93 : 0,
          fk.length >= 8 && x.includes(fk) ? 0.92 : 0);
      }
    } else {
      for (const x of p.keys) {
        let s = jw(k, x);
        if (x.length >= 5 && (x.startsWith(k) || k.startsWith(x))) s = Math.max(s, 0.92);
        if (s > sc) sc = s;
      }
      if (p.fkeys.some((x) => jw(fk, x) >= 0.96)) sc = Math.min(1, sc + 0.02);
    }
    if (sc >= 0.88) out.push({ lat: p.lat, lng: p.lng, label: p.name || p['name:en'], kind: p.kind, score: sc, src: `OSM ${p.kind} '${p.name || p['name:en']}'` });
  }
  // Collapse duplicates (a village node and its bus stop 50 m apart are one candidate).
  out.sort((a, b) => (b.score + KIND_W(b.kind)) - (a.score + KIND_W(a.kind)));
  const kept = [];
  for (const c of out) {
    if (kept.some((q) => haversine(q.lat, q.lng, c.lat, c.lng) < 250)) continue;
    kept.push(c);
    if (kept.length >= 14) break;
  }
  return kept;
}

/**
 * Picks one candidate per stop so the route as a whole is plausible.
 * Each stop may also be "unknown"; a stop is reachable from the last KNOWN
 * stop in the time between them at bus speeds, with a margin.
 */
function solve(stops, traces) {
  const S = stops.map((s, i) => {
    const opts = s.cands.map((c) => {
      let e = Math.log(Math.max(1e-3, (c.score - 0.8) / 0.2)) * 1.5 + KIND_W(c.kind || '') + (c.fixed ? 3 : 0);
      if (traces.length && !c.fixed) {
        const d = minDistToTrace(traces, c.lat, c.lng);
        e += d < 250 ? 1.2 : d < 800 ? 0.4 : d < 2000 ? -0.3 : -1.2;
      }
      return { ...c, e };
    });
    return { i, opts, unknownE: s.forceUnknown ? 0 : -4.0 };
  });
  const tmin = stops.map((s) => (s.time ? minutes(s.time) : null));

  const trans = (a, ia, b, ib) => {
    const D = haversine(a.lat, a.lng, b.lat, b.lng) / 1000;
    const dt = Math.max(2, (tmin[ib] ?? 0) - (tmin[ia] ?? 0));
    const maxD = dt * 0.75 + 2.5;            // ~45 km/h straight line + margin
    let p = -0.08 * D;                        // shorter is likelier
    if (D > maxD) p -= (D - maxD) * 1.2;
    // Heading for college: getting much further away is suspicious.
    const ca = haversine(a.lat, a.lng, CAMPUS.lat, CAMPUS.lng) / 1000;
    const cb = haversine(b.lat, b.lng, CAMPUS.lat, CAMPUS.lng) / 1000;
    if (cb - ca > 4) p -= (cb - ca - 4) * 0.5;
    return p;
  };

  // best[i][k] for k = option index; plus unknown handled by allowing jumps of up to 5.
  const best = S.map((s) => s.opts.map(() => ({ v: -Infinity, from: null })));
  const unkCost = (i0, i1) => { let c = 0; for (let j = i0 + 1; j < i1; j++) c += S[j].unknownE; return c; };
  for (let i = 0; i < S.length; i++) {
    for (let k = 0; k < S[i].opts.length; k++) {
      const o = S[i].opts[k];
      let bestV = unkCost(-1, i) + o.e, from = null;
      for (let j = Math.max(0, i - 6); j < i; j++) {
        for (let q = 0; q < S[j].opts.length; q++) {
          const pv = best[j][q].v;
          if (pv === -Infinity) continue;
          const v = pv + unkCost(j, i) + trans(S[j].opts[q], j, o, i) + o.e;
          if (v > bestV) { bestV = v; from = [j, q]; }
        }
      }
      best[i][k] = { v: bestV, from };
    }
  }
  // End: best over all (i,k) plus unknowns after it.
  let end = null, endV = unkCost(-1, S.length);
  for (let i = 0; i < S.length; i++) for (let k = 0; k < S[i].opts.length; k++) {
    const v = best[i][k].v + unkCost(i, S.length);
    if (v > endV) { endV = v; end = [i, k]; }
  }
  const pick = new Array(S.length).fill(null);
  for (let cur = end; cur; cur = best[cur[0]][cur[1]].from) pick[cur[0]] = S[cur[0]].opts[cur[1]];
  return pick;
}

// ------------------------------------------------------------------- build

function buildBus(bus) {
  const traces = loadTraces(bus.id);
  const H = hints[bus.id] || {};
  const report = [];

  // 1. Candidates per stop.
  const raw = bus.stops.map((s) => {
    const h = H[s.name] || {};
    let cands = [], forceUnknown = false, fixedSrc = null;
    if (isCollege(s.name)) {
      cands = [{ lat: CAMPUS.lat, lng: CAMPUS.lng, score: 1, kind: 'campus', fixed: true, src: 'campus' }];
    } else if (h.lat != null) {
      cands = [{ lat: h.lat, lng: h.lng, score: 1, kind: 'hint', fixed: true, src: h.src || 'hint' }];
      fixedSrc = h.src;
    } else if (h.unknown) {
      forceUnknown = true;
    } else if (h.place) {
      cands = candidatesFor(h.place).filter((c) => c.score >= 0.97).map((c) => ({ ...c, score: 1 }));
    } else {
      cands = candidatesFor(s.name);
    }
    return { ...s, cands, forceUnknown, fixedSrc };
  });

  // 2. Choose.
  const pick = solve(raw, traces);

  // 3. Snap chosen positions to the road.
  const located = raw.map((s, i) => {
    const c = pick[i];
    if (!c) return { ...s, pos: null, how: s.forceUnknown ? 'unknown (hint)' : 'not found' };
    const sn = snap(G, c.lng, c.lat, 600);
    return { ...s, pos: c, snapped: sn, how: c.src, offRoadM: sn ? Math.round(sn.d) : null };
  });

  // 4. Route through the located stops.
  const bias = traces.length ? traceSegments(traces) : null;
  const biasFn = bias ? (s) => (bias.has(s) ? 0.3 : 1.15) : null;
  const known = located.map((s, i) => ({ s, i })).filter((x) => x.s.snapped);
  const shape = [];
  const along = new Map();
  const legLen = (pts) => polylineLength(pts);
  let cur = known[0];
  along.set(cur.i, 0);
  shape.push([cur.s.snapped.lng, cur.s.snapped.lat]);
  let total = 0;
  // A village's map point is its centre, often 300-700 m off the road through
  // it. Buses stop where the road meets the village, so a stop placed from a
  // village name (not a bus stop, not a hand pin) is served from the road
  // between its neighbours when that road passes close enough; the bus only
  // drives in when the village is further off than that.
  const soft = (s) => s.pos && !s.pos.fixed && /^place=/.test(s.pos.kind || '');
  const served = new Map(); // stop index -> {lng, lat} on the through road
  let k = 1;
  while (k < known.length) {
    let next = known[k];
    while (soft(next.s) && k + 1 < known.length) {
      const after = known[k + 1];
      const through = busRoute(G, cur.s.snapped, after.s.snapped, biasFn);
      if (!through) break;
      const tl = dedupe(through.pts), tc = cumulative(tl);
      const pr = projectOnLine(tl, tc, next.s.pos.lng, next.s.pos.lat);
      const direct = busRoute(G, cur.s.snapped, next.s.snapped, biasFn);
      const via = direct && busRoute(G, next.s.snapped, after.s.snapped, biasFn);
      // Close to the through road, and going via the centre would be a real detour.
      // The sheet giving it no time of its own (same minute as a neighbour)
      // says the bus does not turn off for it: allow it further from the road.
      const tm = (x) => (x.s.time ? minutes(x.s.time) : null);
      const quick = Math.min(Math.abs((tm(next) ?? 99) - (tm(cur) ?? -99)), Math.abs((tm(after) ?? 99) - (tm(next) ?? -99))) <= 1;
      if (pr.d > (quick ? 3000 : 900) || !via || direct.timeS + via.timeS < through.timeS * 1.08) break;
      served.set(next.i, { lng: pr.lng, lat: pr.lat, d: Math.round(pr.d) });
      report.push(`  ${next.s.name}: served from the main road, ${Math.round(pr.d)} m from the village centre`);
      k++;
      next = known[k];
    }
    let leg = busRoute(G, cur.s.snapped, next.s.snapped, biasFn);
    if (!leg) {
      report.push(`  !! no road from ${cur.s.name} to ${next.s.name} — straight line used`);
      leg = { pts: [[cur.s.snapped.lng, cur.s.snapped.lat], [next.s.snapped.lng, next.s.snapped.lat]] };
    }
    const pts = dedupe(leg.pts);
    for (let j = 1; j < pts.length; j++) shape.push(pts[j]);
    total += legLen(pts);
    along.set(next.i, total);
    cur = next;
    k++;
  }

  // 5. Clean the line: drop duplicate points, simplify within 2 m.
  let line = simplify(dedupe(shape), 2);
  const cum = cumulative(line);
  const lengthM = Math.round(cum[cum.length - 1]);

  // Re-project known stops onto the simplified line, monotonically.
  let lastAlong = 0;
  for (let q = 0; q < known.length; q++) {
    const { s, i } = known[q];
    const sv = served.get(i);
    const p = sv ?? s.snapped;
    // Window: from the previous stop to just past where this leg was built to
    // end (served stops: up to the next stop that was routed to).
    let upto = along.get(i);
    if (upto == null) for (let r = q + 1; r < known.length; r++) { const a = along.get(known[r].i); if (a != null) { upto = a; break; } }
    const pr = projectOnLine(line, cum, p.lng, p.lat, Math.max(0, lastAlong - 1), (upto ?? lengthM) + 400);
    along.set(i, Math.max(lastAlong, pr.along));
    if (sv) s.offRoadM = sv.d;
    lastAlong = along.get(i);
  }

  // 6. Times.
  const firstT = minutes(bus.stops[0].time);
  let lastOff = 0;
  const offs = bus.stops.map((s) => {
    let o = s.time ? (minutes(s.time) - firstT) * 60 : null;
    if (o == null || o < lastOff) o = lastOff;
    lastOff = o;
    return o;
  });

  // 7. Unknown stops: between known neighbours, by time.
  const knownIdx = known.map((x) => x.i);
  const usedIds = new Set();
  const stops = located.map((s, i) => {
    let d = along.get(i), estimated = false, lng, lat;
    if (d == null) {
      const before = Math.max(...knownIdx.filter((j) => j < i));
      const after = Math.min(...knownIdx.filter((j) => j > i));
      const dA = along.get(before), dB = along.get(after);
      const tA = offs[before], tB = offs[after];
      const f = tB > tA ? (offs[i] - tA) / (tB - tA) : (i - before) / (after - before);
      d = dA + Math.max(0.05, Math.min(0.95, f)) * (dB - dA);
      estimated = true;
    }
    [lng, lat] = atDistance(line, cum, d);
    // Ids are what students' saved stops point at, so they must survive the
    // office inserting or reordering stops: name-based, never position-based.
    let id = `${bus.id}-${slug(isCollege(s.name) ? 'svpcet' : s.name)}`;
    for (let n = 2; usedIds.has(id); n++) id = `${bus.id}-${slug(s.name)}-${n}`;
    usedIds.add(id);
    return {
      id, seq: i, name: isCollege(s.name) ? 'SVPCET' : title(s.name),
      sheetName: s.name,
      lat: +lat.toFixed(6), lng: +lng.toFixed(6),
      distAlongM: Math.round(d),
      geofenceM: estimated ? 250 : (s.pos && /hint|halt|bus_stop|bus_station|campus/.test(s.pos.kind + s.how) ? 80 : 120),
      schedOffsetS: offs[i],
      time: s.time,
      estimated,
      // Verified: pinned by hand, seen on a recorded ride, or an OSM bus stop.
      // A village found by name is probably right but unproven, so the app is
      // slower to tell anyone the bus skipped it.
      verified: !estimated && !!s.pos && (s.pos.fixed || /bus_stop|bus_station/.test(s.pos.kind || '')),
      source: estimated ? 'approximate: placed between neighbouring stops by the timetable' : s.how,
    };
  });

  // 8. Pickup points students gave that are not on the sheet, if the bus passes them.
  const extras = [];
  const wanting = students.filter((st) => !st.stop && (st.bus === bus.id || (!st.bus && st.candidates.includes(bus.id))));
  const byPickup = new Map();
  for (const st of wanting) {
    const key = st.pickup.toUpperCase();
    if (!byPickup.has(key)) byPickup.set(key, []);
    byPickup.get(key).push(st);
  }
  for (const [pickup, group] of byPickup) {
    // Already an official stop of the same name? (spelling the matcher missed)
    const same = stops.find((s) => jw(nameKey(s.sheetName), nameKey(pickup)) >= 0.93);
    if (same) { extras.push({ pickup, n: group.length, result: `same as official stop ${same.name}`, stopId: same.id }); continue; }
    const cands = candidatesFor(pickup, true).filter((c) => c.score >= 0.9);
    let best = null;
    for (const c of cands) {
      const pr = projectOnLine(line, cum, c.lng, c.lat);
      if (pr.d <= 700 && (!best || pr.d < best.pr.d)) best = { c, pr };
    }
    // A pickup named after a road ("KT Road"): the stop is where the bus is
    // on that road — the middle of the stretch it drives along it, or where
    // it crosses it.
    if (!best && /\b(ROAD|RD|STREET|ST)\b/i.test(pickup)) {
      const rk = nameKey(pickup.replace(/\b(RD)\b/i, 'ROAD'), true);
      const ways = ROAD_NAMES.filter((w) => jw(rk, w.key) >= 0.92 || (rk.length >= 5 && w.key.startsWith(rk)));
      const ids = new Set(ways.map((w) => w.id));
      const hits = [];
      for (let i = 0; i < line.length; i++) {
        if (nearSegments(G, line[i][0], line[i][1], 35, (sg) => ids.has(G.eWay[sg])).length) hits.push(i);
      }
      if (hits.length) {
        const i = hits[Math.floor(hits.length / 2)];
        best = { c: { label: ways[0].name, src: `OSM road '${ways[0].name}'` }, pr: { d: 0, along: cum[i], lng: line[i][0], lat: line[i][1] } };
      }
    }
    if (!best) {
      extras.push({ pickup, n: group.length, result: cands.length ? `found at ${cands[0].label} but not on this bus's road (${cands.slice(0, 2).map((c) => `${(projectOnLine(line, cum, c.lng, c.lat).d / 1000).toFixed(1)} km`).join(', ')} away)` : 'not found on the map' });
      continue;
    }
    extras.push({ pickup, n: group.length, result: `on the road, ${Math.round(best.pr.d)} m from ${best.c.label}`, along: best.pr.along, lng: best.pr.lng, lat: best.pr.lat, src: best.c.src });
  }
  for (const x of extras.filter((e) => e.along != null)) {
    // Time by interpolation between the official stops either side.
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) if (stops[i].distAlongM <= x.along && stops[i + 1].distAlongM >= x.along) { a = stops[i]; b = stops[i + 1]; break; }
    const f = b.distAlongM > a.distAlongM ? (x.along - a.distAlongM) / (b.distAlongM - a.distAlongM) : 0;
    const off = Math.round(a.schedOffsetS + f * (b.schedOffsetS - a.schedOffsetS));
    const tt = firstT * 60 + off;
    const s = {
      id: `${bus.id}-x-${slug(x.pickup)}`, seq: -1, name: title(x.pickup), sheetName: null,
      lat: +x.lat.toFixed(6), lng: +x.lng.toFixed(6), distAlongM: Math.round(x.along),
      geofenceM: 120, schedOffsetS: off,
      time: `${String(Math.floor(tt / 3600)).padStart(2, '0')}:${String(Math.round((tt % 3600) / 60)).padStart(2, '0')}`,
      estimated: false, verified: false, extra: true,
      source: `student pickup point, not on the office's sheet; ${x.src}`,
    };
    x.stopId = s.id;
    stops.push(s);
  }
  stops.sort((p, q) => p.distAlongM - q.distAlongM || (p.extra ? 1 : 0) - (q.extra ? 1 : 0));
  stops.forEach((s, i) => { s.seq = i; });

  // 9. Time-vs-distance profile through the stops (the timetable model).
  const durationS = stops[stops.length - 1].schedOffsetS;
  const profile = [];
  const N = Math.max(100, Math.min(600, Math.round(lengthM / 100)));
  for (let q = 0; q <= N; q++) {
    const d = (lengthM * q) / N;
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) if (d >= stops[i].distAlongM && d <= stops[i + 1].distAlongM) { a = stops[i]; b = stops[i + 1]; break; }
    const span = b.distAlongM - a.distAlongM;
    const f = span ? (d - a.distAlongM) / span : 0;
    profile.push({ d: Math.round(d), t: Math.round(a.schedOffsetS + f * (b.schedOffsetS - a.schedOffsetS)) });
  }

  const route = {
    id: bus.id,
    code: bus.code,
    name: `${bus.name} — Campus`,
    short: `${bus.name} Bus`,
    color: COLORS[bus.id] || '#38bdf8',
    schedStart: bus.stops[0].time,
    lengthM,
    durationS,
    shape: line.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]),
    stops,
    profile,
    source: traces.length ? 'osm-road-graph+recorded' : 'osm-road-graph',
    tripSource: 'timetable',
    bus: { number: bus.busNo, driver: bus.driver.name, driverPhone: bus.driver.phone },
    traces: traces.map((t) => t.file),
    builtAt: new Date().toISOString(),
  };

  // 10. Report.
  const lines = [`## ${bus.code}. ${bus.name} (${bus.busNo}, ${bus.driver.name})`, '',
    `${(lengthM / 1000).toFixed(1)} km · ${Math.round(durationS / 60)} min on the sheet · ${stops.length} stops`
    + (traces.length ? ` · follows recorded ride${traces.length > 1 ? 's' : ''}: ${traces.map((t) => t.file).join(', ')}` : ' · no recorded ride yet'), '',
    '| # | Stop | Time | km | Placed by |', '|---|---|---|---|---|'];
  for (const s of stops) {
    lines.push(`| ${s.seq + 1} | ${s.extra ? '➕ ' : ''}${s.name}${s.estimated ? ' ~' : ''} | ${s.time ?? ''} | ${(s.distAlongM / 1000).toFixed(1)} | ${s.source}${located.find((l) => l.name === s.sheetName)?.offRoadM > 150 ? ` (${located.find((l) => l.name === s.sheetName).offRoadM} m from road)` : ''} |`);
  }
  if (extras.length) {
    lines.push('', 'Pickup points students gave that are not on the sheet:', '');
    for (const x of extras) lines.push(`- **${title(x.pickup)}** (${x.n} student${x.n > 1 ? 's' : ''}): ${x.result}`);
  }
  for (const r of report) lines.push(r);
  lines.push('');
  return { route, md: lines.join('\n'), extras };
}

// ---------------------------------------------------------- corridor roads

/**
 * Every road within 3 km of the route, plus the main roads (tertiary and up)
 * for 12 km around it — so a bus that leaves its route is still on a known
 * road, and the line ahead can be routed from wherever it is, the way a
 * navigation app re-routes.
 */
function corridor(route) {
  const NEAR = 3000, FAR = 12000;
  const P = G.P;
  const pts = route.shape.map(([x, y]) => P.xy(x, y));
  const cells = new Map();
  const C = 1000;
  for (let i = 0; i < pts.length; i++) {
    const k = `${Math.floor(pts[i][0] / C)},${Math.floor(pts[i][1] / C)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(pts[i]);
  }
  // Densify long segments so the cell lookup sees them.
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay);
    for (let s = 200; s < L; s += 200) {
      const x = ax + (bx - ax) * s / L, y = ay + (by - ay) * s / L;
      const k = `${Math.floor(x / C)},${Math.floor(y / C)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push([x, y]);
    }
  }
  const distTo = (x, y, limit) => {
    const r = Math.ceil(limit / C);
    const cx = Math.floor(x / C), cy = Math.floor(y / C);
    let best = Infinity;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const l = cells.get(`${cx + i},${cy + j}`);
      if (!l) continue;
      for (const p of l) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < best) best = d; }
    }
    return best;
  };
  const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
  const nodeD = new Map();
  const nd = (i, limit) => {
    let v = nodeD.get(i);
    if (v === undefined) { v = distTo(G.x[i], G.y[i], FAR); nodeD.set(i, v); }
    return v;
  };
  const keepSeg = [];
  for (let s = 0; s < G.m; s++) {
    const cls = CLASSES[G.eCls[s]];
    const a = G.eA[s], b = G.eB[s];
    // Quick reject by the route's bounding box + FAR.
    const da = nd(a), db = nd(b);
    const d = Math.min(da, db);
    if (d <= NEAR || (MAJOR.has(cls) && d <= FAR)) keepSeg.push(s);
  }
  const remap = new Map();
  const outPts = [];
  const idOf = (i) => {
    let j = remap.get(i);
    if (j === undefined) { j = outPts.length / 2; remap.set(i, j); outPts.push(Math.round(G.lng[i] * 1e6), Math.round(G.lat[i] * 1e6)); }
    return j;
  };
  const edges = [];
  for (const s of keepSeg) edges.push(idOf(G.eA[s]), idOf(G.eB[s]), (G.eOne[s] ? 1 : 0) | (G.eCls[s] << 1));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < outPts.length; i += 2) {
    const x = outPts[i] / 1e6, y = outPts[i + 1] / 1e6;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return {
    v: 1, routeId: route.id, builtAt: new Date().toISOString(),
    source: 'OpenStreetMap contributors (ODbL), local extract',
    bufferKm: NEAR / 1000, majorBufferKm: FAR / 1000,
    bbox: [minX, minY, maxX, maxY].map((v) => +v.toFixed(6)),
    classes: CLASSES, pts: outPts, edges,
  };
}

// --------------------------------------------------------------------- run

const buses = transport.buses.filter((b) => !only.length || only.includes(b.id));
mkdirSync(join(ROOT, 'data/routes'), { recursive: true });
mkdirSync(join(ROOT, 'data/roads'), { recursive: true });
const md = [`# Route build report`, '', `Built ${new Date().toISOString()} from ${transport.source} (${transport.year}).`,
  '`~` = approximate position (between neighbours, by time). ➕ = a student pickup point not on the office\'s sheet, found on the road the bus drives.', ''];
const allExtras = [];
for (const bus of buses) {
  const t = Date.now();
  const { route, md: m, extras } = buildBus(bus);
  writeFileSync(join(ROOT, 'data/routes', `${route.id}.json`), JSON.stringify(route));
  const roads = corridor(route);
  const roadsJson = JSON.stringify(roads);
  writeFileSync(join(ROOT, 'data/roads', `${route.id}.roads.json`), roadsJson);
  const est = route.stops.filter((s) => s.estimated).length;
  const ext = route.stops.filter((s) => s.extra).length;
  console.log(`${route.code}. ${route.id.padEnd(13)} ${(route.lengthM / 1000).toFixed(1).padStart(5)} km  ${String(route.stops.length).padStart(2)} stops (${est} approx, ${ext} extra)  roads ${(roadsJson.length / 1e6).toFixed(1)} MB (${(gzipSync(roadsJson).length / 1e6).toFixed(1)} gz)  ${Date.now() - t} ms`);
  md.push(m);
  allExtras.push(...extras.map((e) => ({ bus: bus.id, ...e })));
  if (only.length) for (const x of extras) console.log(`   pickup ${x.pickup}: ${x.result}`);
}

// network.json lists every route that has a data file, in the office's order.
const all = transport.buses.filter((b) => existsSync(join(ROOT, 'data/routes', `${b.id}.json`)))
  .map((b) => read(join(ROOT, 'data/routes', `${b.id}.json`)));
const net = existsSync(join(ROOT, 'data/network.json')) ? read(join(ROOT, 'data/network.json')) : {};
writeFileSync(join(ROOT, 'data/network.json'), JSON.stringify({
  campus: net.campus ?? { name: 'SVPCET', fullName: 'Sri Venkatesa Perumal College of Engineering & Technology', address: 'RVS Nagar, K N Road, Puttur, Tirupati Dist., Andhra Pradesh 517583', lat: 13.43312, lng: 79.50944, catchmentKm: 60 },
  routes: all.map((r) => ({
    id: r.id, code: r.code, name: r.name, short: r.short, color: r.color, schedStart: r.schedStart,
    lengthM: r.lengthM, durationS: r.durationS, stopCount: r.stops.length,
    firstStop: r.stops[0].name, lastStop: r.stops[r.stops.length - 1].name,
    busNumber: r.bus?.number ?? null, driver: r.bus?.driver ?? null,
  })),
  generatedAt: new Date().toISOString(),
}, null, 1));

if (!only.length) {
  writeFileSync(join(ROOT, 'data/official/build-report.md'), md.join('\n'));
  console.log('report: data/official/build-report.md');
}
