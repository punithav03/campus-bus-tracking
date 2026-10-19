/**
 * The service area's road network, for building routes offline.
 *
 * Reads the roads.json written by tools/osm_extract.py (every drivable road
 * between Tirupati, Chittoor and Nagalapuram) and answers two questions:
 *
 *   - which road is nearest to this point?
 *   - what is the road a BUS would take from here to there?
 *
 * The second is a plain A* over travel time, with speeds chosen for a 40-seat
 * bus rather than a car: a bus stays on the main road and only turns into a
 * village street when a stop is in it. An optional "bias" lets a recorded ride
 * pull the route onto the roads the bus was actually seen on.
 *
 * Build-time only. The server never loads this; it loads the per-route
 * corridor files this helps write.
 */

import { readFileSync } from 'node:fs';

export const CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'track', 'road',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];
const CLS = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

/** Metres per second a loaded college bus actually manages on each class. */
const SPEED = {
  motorway: 22, trunk: 17, primary: 14, secondary: 12, tertiary: 10, unclassified: 7.5,
  residential: 5, living_street: 3, service: 3, track: 2, road: 5,
  motorway_link: 12, trunk_link: 10, primary_link: 9, secondary_link: 8, tertiary_link: 7,
};

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lng1, lat2, lng2) {
  const dp = rad(lat2 - lat1), dl = rad(lng2 - lng1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Flat metres around a reference latitude — fine over this ~100 km area. */
export function projector(lat0, lng0) {
  const ky = 110574, kx = 111320 * Math.cos(rad(lat0));
  return {
    xy: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky],
    ll: (x, y) => [x / kx + lng0, y / ky + lat0],
  };
}

export function loadRegion(roadsPath) {
  const ways = JSON.parse(readFileSync(roadsPath, 'utf8'));
  const idx = new Map();
  const lng = [], lat = [];
  const node = (id, c) => {
    let i = idx.get(id);
    if (i === undefined) { i = lng.length; idx.set(id, i); lng.push(c[0]); lat.push(c[1]); }
    return i;
  };
  const eA = [], eB = [], eCls = [], eOne = [], eWay = [];
  for (const w of ways) {
    const cls = CLS[w.hw] ?? CLS.road;
    for (let k = 1; k < w.n.length; k++) {
      const a = node(w.n[k - 1], w.c[k - 1]), b = node(w.n[k], w.c[k]);
      if (a === b) continue;
      if (w.oneway === -1) { eA.push(b); eB.push(a); } else { eA.push(a); eB.push(b); }
      eCls.push(cls); eOne.push(w.oneway ? 1 : 0); eWay.push(w.id);
    }
  }
  const n = lng.length, m = eA.length;
  const lat0 = 13.47, lng0 = 79.45;
  const P = projector(lat0, lng0);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { const p = P.xy(lng[i], lat[i]); x[i] = p[0]; y[i] = p[1]; }
  const len = new Float64Array(m);
  for (let s = 0; s < m; s++) len[s] = Math.hypot(x[eB[s]] - x[eA[s]], y[eB[s]] - y[eA[s]]);

  // CSR adjacency, both directions unless oneway.
  const deg = new Int32Array(n + 1);
  for (let s = 0; s < m; s++) { deg[eA[s]]++; if (!eOne[s]) deg[eB[s]]++; }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const to = new Int32Array(start[n]), via = new Int32Array(start[n]);
  const fill = start.slice(0, n);
  for (let s = 0; s < m; s++) {
    to[fill[eA[s]]] = eB[s]; via[fill[eA[s]]++] = s;
    if (!eOne[s]) { to[fill[eB[s]]] = eA[s]; via[fill[eB[s]]++] = s; }
  }

  // Grid over segments, 250 m cells.
  const CELL = 250, grid = new Map();
  const key = (cx, cy) => (cx + 100000) * 200000 + (cy + 100000);
  for (let s = 0; s < m; s++) {
    const a = eA[s], b = eB[s];
    const cx0 = Math.floor(Math.min(x[a], x[b]) / CELL), cx1 = Math.floor(Math.max(x[a], x[b]) / CELL);
    const cy0 = Math.floor(Math.min(y[a], y[b]) / CELL), cy1 = Math.floor(Math.max(y[a], y[b]) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = key(cx, cy); const l = grid.get(k); if (l) l.push(s); else grid.set(k, [s]);
    }
  }

  const g = { n, m, lng, lat, x, y, eA, eB, eCls, eOne, eWay, len, start, to, via, grid, CELL, key, P };
  return g;
}

/** Foot of the perpendicular from (px,py) onto segment s. */
function foot(g, s, px, py) {
  const a = g.eA[s], b = g.eB[s];
  const dx = g.x[b] - g.x[a], dy = g.y[b] - g.y[a];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - g.x[a]) * dx + (py - g.y[a]) * dy) / L2)) : 0;
  const fx = g.x[a] + t * dx, fy = g.y[a] + t * dy;
  return { s, t, fx, fy, d: Math.hypot(px - fx, py - fy) };
}

/** Segments within `radius` metres of a point, nearest first. */
export function nearSegments(g, lng, lat, radius = 200, filter = null) {
  const [px, py] = g.P.xy(lng, lat);
  const r = Math.ceil(radius / g.CELL);
  const cx = Math.floor(px / g.CELL), cy = Math.floor(py / g.CELL);
  const seen = new Set(), out = [];
  for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
    const l = g.grid.get(g.key(cx + i, cy + j));
    if (!l) continue;
    for (const s of l) {
      if (seen.has(s)) continue; seen.add(s);
      if (filter && !filter(s)) continue;
      const f = foot(g, s, px, py);
      if (f.d <= radius) out.push(f);
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

const BUSWORTHY = (g) => (s) => {
  const c = CLASSES[g.eCls[s]];
  return c !== 'service' && c !== 'track' && c !== 'living_street';
};

/**
 * Where a stop meets the road. Prefers a road a bus would use; a stop at the
 * end of a village lane is snapped to the lane only if nothing better is near.
 */
export function snap(g, lng, lat, radius = 400) {
  const good = nearSegments(g, lng, lat, radius, BUSWORTHY(g));
  const any = good.length ? good : nearSegments(g, lng, lat, radius);
  if (!any.length) return null;
  // A main road 60 m away beats a residential lane 20 m away.
  const rank = (f) => f.d + (g.eCls[f.s] >= 5 && g.eCls[f.s] <= 10 ? 40 : 0);
  any.sort((a, b) => rank(a) - rank(b));
  const f = any[0];
  const [flng, flat] = g.P.ll(f.fx, f.fy);
  return { ...f, lng: flng, lat: flat };
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v; const top = v[0]; const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * The road a bus would take between two snapped points, as [lng, lat][].
 *
 * `bias(s)` returns a cost multiplier for segment s (1 = neutral, <1 = prefer).
 * Returns null if the two are not connected.
 */
export function busRoute(g, from, to, bias = null) {
  const VMAX = 22 * 1.0;
  const tx = to.fx, ty = to.fy;
  const h = (i) => Math.hypot(g.x[i] - tx, g.y[i] - ty) / VMAX * 0.35; // weak but admissible-ish
  const cost = new Map(), prev = new Map(), prevSeg = new Map();
  const heap = new Heap();
  const segCost = (s, frac = 1) => {
    const c = CLASSES[g.eCls[s]];
    return (g.len[s] * frac) / SPEED[c] * (bias ? bias(s) : 1);
  };
  // Leave the start point along its segment in either permitted direction.
  const sa = g.eA[from.s], sb = g.eB[from.s];
  const seed = (node, c) => { if (!(cost.get(node) <= c)) { cost.set(node, c); prev.set(node, -1); heap.push(c + h(node), node); } };
  seed(sb, segCost(from.s, 1 - from.t));
  if (!g.eOne[from.s]) seed(sa, segCost(from.s, from.t));
  // Target: arrive on its segment from either end.
  const ta = g.eA[to.s], tb = g.eB[to.s];
  const finishVia = new Map();
  finishVia.set(ta, segCost(to.s, to.t));
  if (!g.eOne[to.s]) finishVia.set(tb, segCost(to.s, 1 - to.t));
  // Same segment, forward: drive straight along it.
  let best = Infinity, bestEnd = -2;
  if (from.s === to.s && (to.t >= from.t || !g.eOne[from.s])) {
    best = segCost(from.s, Math.abs(to.t - from.t)); bestEnd = -1;
  }
  const done = new Set();
  let pops = 0;
  while (heap.size) {
    const u = heap.pop();
    if (done.has(u)) continue; done.add(u);
    const cu = cost.get(u);
    if (cu >= best) break;
    if (++pops > 3_000_000) break;
    const fin = finishVia.get(u);
    if (fin !== undefined && cu + fin < best) { best = cu + fin; bestEnd = u; }
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.to[k], s = g.via[k];
      const c = cu + segCost(s);
      if (c < (cost.get(v) ?? Infinity)) {
        cost.set(v, c); prev.set(v, u); prevSeg.set(v, s);
        heap.push(c + h(v), v);
      }
    }
  }
  if (bestEnd === -2) return null;
  const pts = [[from.lng, from.lat]];
  if (bestEnd >= 0) {
    const chain = [];
    for (let v = bestEnd; v !== -1 && v !== undefined; v = prev.get(v)) chain.push(v);
    chain.reverse();
    for (const v of chain) pts.push([g.lng[v], g.lat[v]]);
  }
  pts.push([to.lng, to.lat]);
  return { pts, timeS: best };
}

export function polylineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
  return d;
}

/** Douglas–Peucker in local metres; keeps road shape to within `tol` metres. */
export function simplify(pts, tol = 2) {
  if (pts.length < 3) return pts.slice();
  const P = projector(pts[0][1], pts[0][0]);
  const xy = pts.map((p) => P.xy(p[0], p[1]));
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let md = -1, mk = -1;
    const [ax, ay] = xy[i], [bx, by] = xy[j];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let k = i + 1; k < j; k++) {
      const t = L2 ? Math.max(0, Math.min(1, ((xy[k][0] - ax) * dx + (xy[k][1] - ay) * dy) / L2)) : 0;
      const d = Math.hypot(xy[k][0] - (ax + t * dx), xy[k][1] - (ay + t * dy));
      if (d > md) { md = d; mk = k; }
    }
    if (md > tol) { keep[mk] = 1; stack.push([i, mk], [mk, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Drops consecutive duplicates. */
export function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push(p);
  }
  return out;
}

/**
 * Projects points onto a polyline in order, never going backwards by more than
 * `slackM`. Returns distance along for each.
 */
export function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  return c;
}

export function projectOnLine(pts, cum, lng, lat, fromM = 0, toM = Infinity) {
  const P = projector(lat, lng);
  let best = { d: Infinity, along: 0, lng, lat };
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < fromM || cum[i - 1] > toM) continue;
    const [ax, ay] = P.xy(pts[i - 1][0], pts[i - 1][1]);
    const [bx, by] = P.xy(pts[i][0], pts[i][1]);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / L2)) : 0;
    const fx = ax + t * dx, fy = ay + t * dy;
    const d = Math.hypot(fx, fy);
    if (d < best.d) {
      const [flng, flat] = P.ll(fx, fy);
      best = { d, along: cum[i - 1] + t * (cum[i] - cum[i - 1]), lng: flng, lat: flat };
    }
  }
  return best;
}

export function atDistance(pts, cum, d) {
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= d) {
      const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return [pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1])];
    }
  }
  return pts[pts.length - 1];
}

// ------------------------------------------------------------------ names

/**
 * Reduces a South Indian place name to a spelling-proof key.
 * "Pichchatur", "Pichatoor" and "PICHATTUR" all become "PICATUR".
 */
export function nameKey(s, full = false) {
  let t = String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ');
  if (!full) t = t.replace(/\b(BUS ?STOP|BUS ?STAND|BUS ?STATION|APSRTC|CENTER|CENTRE|VILLAGE|JUNCTION|JN|X ROAD|X ROADS|CROSS ROAD|CROSS|BYPASS|CIRCLE|GATE|ROAD|STATION|NEW|OLD|MAIN|STAGE|COLONY|HOSPITAL|TEMPLE|PARK|MAHAL)\b/g, ' ');
  t = t.replace(/\s+/g, '');
  const rules = [
    [/KHANDRIGA|KANDRIKA|KHANDRIKA/g, 'KANDRIGA'], [/PURAMU/g, 'PURAM'], [/PETTAI|PETTA|PET(?!A)/g, 'PETA'],
    [/PALLE|PALLY|PALLI/g, 'PALI'], [/PALYAM|PALEM/g, 'PALEM'], [/AGRAHARAM|AGRAHRAM/g, 'AGRAHARAM'],
    [/CHCH/g, 'CH'], [/TH/g, 'T'], [/DH/g, 'D'], [/KH/g, 'K'], [/GH/g, 'G'], [/BH/g, 'B'], [/PH/g, 'P'], [/SH/g, 'S'],
    [/CH/g, 'C'], [/OO|OU/g, 'U'], [/EE|IE/g, 'I'], [/AA/g, 'A'], [/Y/g, 'I'], [/W/g, 'V'], [/Z/g, 'J'],
    [/(.)\1+/g, '$1'], [/U(?=R$)/g, 'U'],
  ];
  for (const [a, b] of rules) t = t.replace(a, b);
  return t;
}

/** Jaro–Winkler similarity, 0..1. */
export function jw(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Uint8Array(a.length), bm = new Uint8Array(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - md); j < Math.min(b.length, i + md + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = 1; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const j = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0; while (p < 4 && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}
