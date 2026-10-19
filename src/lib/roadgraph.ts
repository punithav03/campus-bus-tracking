/**
 * The roads around a route, as a graph the server can search.
 *
 * Built from data/roads/<route>.roads.json, which scripts/build-routes.mjs
 * extracts from OpenStreetMap. Everything here works in local metres rather
 * than degrees: a corridor is at most ~100 km across, and over that span a
 * flat projection centred on the corridor is accurate to a fraction of a percent — a
 * few centimetres on a 50 m road segment — while making every distance a plain
 * Pythagoras.
 *
 * Two jobs:
 *   - "which roads could this GPS fix be on?"  — a grid index over segments
 *   - "how far by road from here to there?"    — Dijkstra / A* over the graph
 *
 * Server-only (reads the file system). Nothing here knows about buses.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CELL_M = 100;

export interface RoadGraph {
  routeId: string;
  builtAt: string;
  /** Node coordinates, local metres and degrees. */
  x: Float64Array; y: Float64Array;
  lng: Float64Array; lat: Float64Array;
  /** Segments — one per OSM edge, as stored. Direction a -> b is the drawn one. */
  segA: Int32Array; segB: Int32Array; segLen: Float64Array;
  segOneway: Uint8Array; segCls: Uint8Array;
  /** Directed adjacency in CSR form: out-edges of node i are adjStart[i]..adjStart[i+1]. */
  adjStart: Int32Array; adjTo: Int32Array; adjLen: Float64Array; adjSeg: Int32Array;
  classes: string[];
  /** Spatial index: cell key -> segment ids touching it. */
  grid: Map<number, number[]>;
  /** Projection constants. */
  lat0: number; lng0: number; kx: number; ky: number;
}

/** A place on the road network: a point part-way along one segment. */
export interface RoadPos {
  seg: number;
  /** 0 at segA, 1 at segB. */
  t: number;
  x: number; y: number;
  /** Distance from the GPS fix that produced it. 0 for a position built directly. */
  dist: number;
}

const cache = new Map<string, RoadGraph | null>();

/**
 * The graph for one route, or null if nobody has built it yet — in which case
 * the engine carries on exactly as it did before road matching existed.
 */
export function getRoadGraph(routeId: string): RoadGraph | null {
  if (cache.has(routeId)) return cache.get(routeId)!;
  const path = join(process.cwd(), 'data', 'roads', `${routeId}.roads.json`);
  let g: RoadGraph | null = null;
  if (existsSync(path)) {
    try {
      g = build(routeId, JSON.parse(readFileSync(path, 'utf8')));
    } catch (e) {
      console.error(`[roads] ${routeId}: could not load ${path}`, e);
    }
  }
  cache.set(routeId, g);
  return g;
}

interface RawGraph {
  builtAt: string;
  bbox: [number, number, number, number];
  classes: string[];
  pts: number[];
  edges: number[];
}

function build(routeId: string, raw: RawGraph): RoadGraph {
  const n = raw.pts.length / 2;
  const lat0 = (raw.bbox[1] + raw.bbox[3]) / 2;
  const lng0 = (raw.bbox[0] + raw.bbox[2]) / 2;
  const ky = 110574;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);

  const lng = new Float64Array(n), lat = new Float64Array(n);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lng[i] = raw.pts[2 * i] / 1e6;
    lat[i] = raw.pts[2 * i + 1] / 1e6;
    x[i] = (lng[i] - lng0) * kx;
    y[i] = (lat[i] - lat0) * ky;
  }

  const m = raw.edges.length / 3;
  const segA = new Int32Array(m), segB = new Int32Array(m);
  const segLen = new Float64Array(m);
  const segOneway = new Uint8Array(m), segCls = new Uint8Array(m);
  const outDeg = new Int32Array(n);
  for (let s = 0; s < m; s++) {
    const a = raw.edges[3 * s], b = raw.edges[3 * s + 1], meta = raw.edges[3 * s + 2];
    segA[s] = a; segB[s] = b;
    segLen[s] = Math.hypot(x[b] - x[a], y[b] - y[a]);
    segOneway[s] = meta & 1;
    segCls[s] = meta >> 1;
    outDeg[a]++;
    if (!segOneway[s]) outDeg[b]++;
  }

  const adjStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + outDeg[i];
  const total = adjStart[n];
  const adjTo = new Int32Array(total), adjLen = new Float64Array(total), adjSeg = new Int32Array(total);
  const fill = adjStart.slice(0, n);
  for (let s = 0; s < m; s++) {
    const a = segA[s], b = segB[s];
    let k = fill[a]++;
    adjTo[k] = b; adjLen[k] = segLen[s]; adjSeg[k] = s;
    if (!segOneway[s]) {
      k = fill[b]++;
      adjTo[k] = a; adjLen[k] = segLen[s]; adjSeg[k] = s;
    }
  }

  const grid = new Map<number, number[]>();
  for (let s = 0; s < m; s++) {
    const a = segA[s], b = segB[s];
    const cx0 = Math.floor(Math.min(x[a], x[b]) / CELL_M), cx1 = Math.floor(Math.max(x[a], x[b]) / CELL_M);
    const cy0 = Math.floor(Math.min(y[a], y[b]) / CELL_M), cy1 = Math.floor(Math.max(y[a], y[b]) / CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = cellKey(cx, cy);
        const list = grid.get(key);
        if (list) list.push(s); else grid.set(key, [s]);
      }
    }
  }

  return {
    routeId, builtAt: raw.builtAt,
    x, y, lng, lat, segA, segB, segLen, segOneway, segCls,
    adjStart, adjTo, adjLen, adjSeg, classes: raw.classes, grid,
    lat0, lng0, kx, ky,
  };
}

const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

// ------------------------------------------------------------- projection

export function toXY(g: RoadGraph, lng: number, lat: number): [number, number] {
  return [(lng - g.lng0) * g.kx, (lat - g.lat0) * g.ky];
}

export function toLngLat(g: RoadGraph, x: number, y: number): [number, number] {
  return [g.lng0 + x / g.kx, g.lat0 + y / g.ky];
}

// ------------------------------------------------------------- candidates

/**
 * Every road this fix could plausibly be on, nearest first.
 *
 * One candidate per segment, at the foot of the perpendicular. Several will
 * sit on the same physical spot where segments meet at a junction — that is
 * deliberate: they differ in which way the bus can carry on from there, and
 * the matcher needs to be able to tell those apart.
 */
export function candidates(g: RoadGraph, px: number, py: number, radius: number, max = 10): RoadPos[] {
  const out: RoadPos[] = [];
  const seen = new Set<number>();
  const c0x = Math.floor((px - radius) / CELL_M), c1x = Math.floor((px + radius) / CELL_M);
  const c0y = Math.floor((py - radius) / CELL_M), c1y = Math.floor((py + radius) / CELL_M);
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cy = c0y; cy <= c1y; cy++) {
      const list = g.grid.get(cellKey(cx, cy));
      if (!list) continue;
      for (const s of list) {
        if (seen.has(s)) continue;
        seen.add(s);
        const p = footOn(g, s, px, py);
        if (p.dist <= radius) out.push(p);
      }
    }
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.length > max ? out.slice(0, max) : out;
}

/** The nearest point on segment s to (px, py). */
export function footOn(g: RoadGraph, s: number, px: number, py: number): RoadPos {
  const a = g.segA[s], b = g.segB[s];
  const ax = g.x[a], ay = g.y[a];
  const dx = g.x[b] - ax, dy = g.y[b] - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx, y = ay + t * dy;
  return { seg: s, t, x, y, dist: Math.hypot(px - x, py - y) };
}

/** The nearest point on the whole network, however far. Null if the graph is empty. */
export function nearest(g: RoadGraph, px: number, py: number): RoadPos | null {
  for (let r = 50; r <= 6400; r *= 2) {
    const c = candidates(g, px, py, r, 1);
    if (c.length) return c[0];
  }
  return null;
}

/** Travel direction of segment s, a -> b, as a compass bearing in degrees. */
export function segBearing(g: RoadGraph, s: number): number {
  const a = g.segA[s], b = g.segB[s];
  const deg = (Math.atan2(g.x[b] - g.x[a], g.y[b] - g.y[a]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// ---------------------------------------------------------------- routing

/**
 * Shortest road distances from one road position, out to `bound` metres.
 *
 * Starts part-way along a segment rather than at a node, which is the whole
 * difficulty: from the middle of a two-way road the bus can head for either
 * end, but from the middle of a one-way road only the far one.
 *
 * Returns the distance and predecessor of every node reached. Bounded,
 * because the matcher asks this question for every candidate of every fix
 * and the answer only matters a few hundred metres out.
 */
export interface Reach {
  from: RoadPos;
  dist: Map<number, number>;
  prev: Map<number, number>;   // node -> previous node (-1 = the start position)
}

export function reachFrom(g: RoadGraph, from: RoadPos, bound: number, target?: RoadPos): Reach {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap = new MinHeap();
  const s = from.seg;
  const a = g.segA[s], b = g.segB[s], L = g.segLen[s];

  // A* heuristic when a single destination is known — straight-line distance
  // never overestimates road distance, so the answer stays exact.
  const h = target
    ? (n: number) => Math.hypot(g.x[n] - target.x, g.y[n] - target.y)
    : () => 0;
  // With a target, stop as soon as nothing left in the queue can beat the
  // best route found to it so far — A*'s usual exit, adapted to a target
  // that sits part-way along a segment rather than on a node.
  const tA = target ? g.segA[target.seg] : -1;
  const tB = target ? g.segB[target.seg] : -1;
  const tL = target ? g.segLen[target.seg] : 0;
  let bestToTarget = Infinity;

  const seed = (n: number, d: number) => {
    if (d < (dist.get(n) ?? Infinity)) {
      dist.set(n, d); prev.set(n, -1); heap.push(n, d + h(n));
    }
  };
  seed(b, (1 - from.t) * L);
  if (!g.segOneway[s]) seed(a, from.t * L);

  const done = new Set<number>();
  while (heap.size) {
    const [u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    const du = dist.get(u)!;
    if (du > bound) break;
    if (target) {
      if (u === tA) bestToTarget = Math.min(bestToTarget, du + target.t * tL);
      if (u === tB && !g.segOneway[target.seg]) bestToTarget = Math.min(bestToTarget, du + (1 - target.t) * tL);
      if (du + h(u) >= bestToTarget) break;
    }
    for (let k = g.adjStart[u]; k < g.adjStart[u + 1]; k++) {
      const v = g.adjTo[k];
      const dv = du + g.adjLen[k];
      if (dv < (dist.get(v) ?? Infinity)) {
        dist.set(v, dv); prev.set(v, u); heap.push(v, dv + h(v));
      }
    }
  }
  return { from, dist, prev };
}

/**
 * Road distance from a Reach's start to another road position, and the node
 * path between them. Infinity if it was not reached inside the bound.
 *
 * `jitterM`: GPS noise makes a parked bus wobble back and forth along its
 * own road. On a one-way street that small step "backwards" would otherwise
 * cost a trip around the block, so tiny reverses are forgiven.
 */
export function distTo(g: RoadGraph, r: Reach, to: RoadPos, jitterM = 15): { d: number; via: 'same' | 'a' | 'b' | null } {
  const s = to.seg, L = g.segLen[s];
  let best = Infinity, via: 'same' | 'a' | 'b' | null = null;

  if (r.from.seg === s) {
    const fwd = (to.t - r.from.t) * L;
    if (fwd >= 0) { best = fwd; via = 'same'; }
    else if (!g.segOneway[s] || -fwd <= jitterM) { best = -fwd; via = 'same'; }
  }
  const da = r.dist.get(g.segA[s]);
  if (da != null && da + to.t * L < best) { best = da + to.t * L; via = 'a'; }
  if (!g.segOneway[s]) {
    const db = r.dist.get(g.segB[s]);
    if (db != null && db + (1 - to.t) * L < best) { best = db + (1 - to.t) * L; via = 'b'; }
  }
  return { d: best, via };
}

/** The drawn geometry between a Reach's start and `to`, as local-metre points. */
export function pathTo(g: RoadGraph, r: Reach, to: RoadPos, via: 'same' | 'a' | 'b' | null): [number, number][] {
  const pts: [number, number][] = [[r.from.x, r.from.y]];
  if (via === 'a' || via === 'b') {
    const end = via === 'a' ? g.segA[to.seg] : g.segB[to.seg];
    const nodes: number[] = [];
    let n = end;
    let guard = 0;
    while (n !== -1 && guard++ < 100000) {
      nodes.push(n);
      n = r.prev.get(n) ?? -1;
    }
    nodes.reverse();
    for (const k of nodes) pts.push([g.x[k], g.y[k]]);
  }
  pts.push([to.x, to.y]);
  return pts;
}

// ------------------------------------------------------------------- heap

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, pri: number) {
    const k = this.k, v = this.v;
    k.push(key); v.push(pri);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

// --------------------------------------------------------- point to point

/**
 * Shortest road route between two places, for the line drawn AHEAD of a bus
 * that has left its planned route, and for working out which stops a bus
 * could have passed while its phone was silent.
 *
 * Null when either end is far from any known road, or no route exists inside
 * a sensible detour — the caller then says "unknown" rather than draw a line
 * across a field.
 */
export function routeBetween(
  g: RoadGraph, from: [number, number], to: [number, number],
): { distM: number; coords: [number, number][] } | null {
  const [fx, fy] = toXY(g, from[0], from[1]);
  const [tx, ty] = toXY(g, to[0], to[1]);
  const a = nearest(g, fx, fy);
  const b = nearest(g, tx, ty);
  if (!a || !b || a.dist > 300 || b.dist > 300) return null;
  const straight = Math.hypot(tx - fx, ty - fy);
  const r = reachFrom(g, a, straight * 2.5 + 1500, b);
  const res = distTo(g, r, b, 0);
  if (!Number.isFinite(res.d)) return null;
  const pts = pathTo(g, r, b, res.via);
  return {
    distM: res.d,
    coords: pts.map(([x, y]) => toLngLat(g, x, y)),
  };
}
