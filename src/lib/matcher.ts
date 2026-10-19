/**
 * Online map matching: which road is the bus actually on?
 *
 * A single GPS fix cannot answer that. At 10 m of error a fix near a fork is
 * equally close to both roads, and snapping it to the nearest one is how
 * trackers end up drawing a bus down a side street it never entered. What
 * answers it is a minute of fixes taken together: only one road can explain
 * the whole sequence, because the bus has to be able to DRIVE from each
 * position to the next in the time between them.
 *
 * That is a hidden Markov model (Newson & Krumm, 2009), solved with Viterbi:
 *
 *   emission    how close the fix is to the candidate road position
 *   transition  how well the road distance between two candidates agrees with
 *               the straight-line distance between the two fixes — a bus that
 *               moved 15 m in a straight line did not travel 400 m by road
 *
 * It runs ONLINE, with a fixed lag. Every fix adds a layer; the marker is the
 * best candidate of the newest layer; and once a layer is LAG_S old its choice
 * is settled and its road geometry joins the permanent trail. The newest
 * minute is drawn too, but may still be redrawn as more fixes arrive — which
 * is the point: it is exactly the minute in which the matcher is still making
 * its mind up between two roads at a fork.
 *
 * What it never does is invent. No candidate road within reach means the fix
 * is drawn as raw GPS and labelled so. A silence longer than GAP_S is left as
 * a gap in the line rather than bridged with a guess.
 */

import {
  candidates, distTo, pathTo, reachFrom, toLngLat, toXY,
  type Reach, type RoadGraph, type RoadPos,
} from './roadgraph';

/** Settle a choice once it is this old. ~60 s is where a fork stops being ambiguous. */
const LAG_S = 60;
/** Silence longer than this is a gap, drawn as one. */
export const GAP_S = 45;
/** Top speed for the reachability bound, m/s. */
const MAX_SPEED_MPS = 30;
/** Transition tolerance, metres: how much road vs straight-line disagreement is normal. */
const BETA_M = 6;
/** Fixes closer than this to the last one add nothing but noise — a parked bus. */
const MIN_STEP_M = 4;
/** Consecutive unexplainable fixes to discard as noise before declaring a break. */
const MAX_MISSES = 4;

export type LngLat = [number, number];

export interface TrailSeg {
  /** 'road' = matched to a known road. 'gps' = raw fixes joined by straight lines. */
  kind: 'road' | 'gps';
  pts: LngLat[];
  /** Device time of the last point, epoch ms. */
  t1: number;
}

export interface MatchedPos {
  lng: number; lat: number;
  x: number; y: number;
  /** On a known road (true) or a raw fix nowhere near one (false). */
  onRoad: boolean;
  /** Road distance covered since the previous fix, when known. */
  stepM: number | null;
  /** Direction of travel from the matched road geometry, degrees, when moving. */
  heading: number | null;
  t: number;
}

interface Fix { t: number; x: number; y: number; sigma: number; lng: number; lat: number }

interface Cand extends RoadPos {
  score: number;
  back: number;
  /** Road geometry from the chosen previous candidate, local metres. */
  path: [number, number][] | null;
  stepM: number;
}

interface Layer { fix: Fix; cands: Cand[] }

export class Matcher implements PathTracker {
  private layers: Layer[] = [];
  /** The settled trail. Append-only, so a client can fetch just what is new. */
  readonly committed: TrailSeg[] = [];
  private lastFed: Fix | null = null;
  private misses = 0;
  private tailCache: LngLat[] | null = null;
  current: MatchedPos | null = null;
  /** Count of points ever committed, for incremental fetches. */
  committedPts = 0;

  constructor(readonly g: RoadGraph) {}

  /**
   * Feed one fix. Returns where the bus is now — on a road if it can be
   * explained by one, otherwise the raw fix.
   */
  push(t: number, lng: number, lat: number, acc: number | null | undefined): MatchedPos {
    const [x, y] = toXY(this.g, lng, lat);
    // Phones report a 68% radius. Treat a fraction of it as the noise scale,
    // floored so a phone boasting "3 m" cannot make the model overconfident.
    const sigma = Math.max(5, Math.min(20, (acc ?? 10) / 2));
    const fix: Fix = { t, x, y, sigma, lng, lat };

    // A parked bus: the fix only wobbles. Do not let the wobble draw anything.
    if (this.lastFed && this.current &&
        Math.hypot(x - this.lastFed.x, y - this.lastFed.y) < MIN_STEP_M &&
        t - this.lastFed.t < 15_000) {
      this.current = { ...this.current, stepM: 0, t };
      return this.current;
    }

    const radius = Math.max(50, Math.min(100, sigma * 6));
    const near = candidates(this.g, x, y, radius, 10);
    const prev = this.layers[this.layers.length - 1];
    const dtS = prev ? (t - prev.fix.t) / 1000 : 0;

    // Nowhere near a road we know. Draw it as it is and say so.
    if (!near.length) {
      this.finish();
      this.appendGps([lng, lat], t);
      this.lastFed = fix;
      this.current = { lng, lat, x, y, onRoad: false, stepM: null, heading: null, t };
      return this.current;
    }

    if (!prev || dtS > GAP_S) {
      // First fix of a run, or after a silence long enough to be a gap.
      if (prev) this.finish();
      this.startChain(fix, near);
    } else if (!this.extend(fix, near, dtS)) {
      // No road path explains the move. Either the fix jumped — multipath off
      // a building, a burst of bad fixes after a gap — or the bus really is on
      // a road OpenStreetMap does not have. A jump corrects itself within a
      // few fixes, so give it that long before believing it: skip the fix and
      // keep the chain. Only if the fixes keep refusing to fit is it a real
      // break, and then settle what we had and start again from here.
      if (this.misses < MAX_MISSES && t - prev.fix.t < 20_000) {
        this.misses++;
        if (this.current) this.current = { ...this.current, stepM: null, t };
        return this.current ?? { lng, lat, x, y, onRoad: false, stepM: null, heading: null, t };
      }
      this.finish();
      this.startChain(fix, near);
    }
    this.misses = 0;

    this.lastFed = fix;
    this.settle();
    this.tailCache = null;

    const layer = this.layers[this.layers.length - 1];
    const best = layer.cands.reduce((a, c) => (c.score > a.score ? c : a));
    const [blng, blat] = toLngLat(this.g, best.x, best.y);
    this.current = {
      lng: blng, lat: blat, x: best.x, y: best.y, onRoad: true,
      stepM: best.path ? best.stepM : null,
      heading: headingOf(best.path),
      t,
    };
    return this.current;
  }

  /**
   * The newest, still-revisable stretch: from the end of the settled trail to
   * the marker. Drawn as a continuation of the trail, so the user just sees
   * one line that ends at the bus.
   */
  tail(): LngLat[] {
    if (this.tailCache) return this.tailCache;
    if (this.layers.length === 0) return (this.tailCache = []);
    const chosen = this.backtrack();
    const out: LngLat[] = [];
    const first = chosen[0];
    out.push(toLngLat(this.g, first.x, first.y));
    for (let i = 1; i < chosen.length; i++) {
      const p = chosen[i].path;
      if (!p) continue;
      for (let k = 1; k < p.length; k++) out.push(toLngLat(this.g, p[k][0], p[k][1]));
    }
    return (this.tailCache = dedupe(out));
  }

  /** Settle everything — the trip has ended. */
  close() { this.finish(); }

  /** Put back a trail saved before a restart. Matching resumes fresh from the next fix. */
  restore(segs: TrailSeg[]) {
    this.committed.length = 0;
    this.committed.push(...segs);
    this.committedPts = segs.reduce((n, s) => n + s.pts.length, 0);
  }

  // ------------------------------------------------------------------ HMM

  private startChain(fix: Fix, near: RoadPos[]) {
    this.layers = [{
      fix,
      cands: near.map((c) => ({ ...c, score: emission(c.dist, fix.sigma), back: -1, path: null, stepM: 0 })),
    }];
  }

  /** Viterbi step. False if no candidate is reachable from any previous one. */
  private extend(fix: Fix, near: RoadPos[], dtS: number): boolean {
    const prev = this.layers[this.layers.length - 1];
    const straight = Math.hypot(fix.x - prev.fix.x, fix.y - prev.fix.y);
    // How far a bus could have driven in the time available, plus slack for
    // the noise at both ends.
    const bound = MAX_SPEED_MPS * Math.max(1, dtS) * 1.2 + 60;

    const next: Cand[] = near.map((c) => ({
      ...c, score: -Infinity, back: -1, path: null, stepM: 0,
    }));
    const reaches: (Reach | null)[] = prev.cands.map((p) =>
      Number.isFinite(p.score) ? reachFrom(this.g, p, bound) : null);
    const vias: ({ d: number; via: 'same' | 'a' | 'b' | null } | null)[][] = [];

    for (let j = 0; j < prev.cands.length; j++) {
      const r = reaches[j];
      vias[j] = [];
      if (!r) continue;
      for (let i = 0; i < next.length; i++) {
        const res = distTo(this.g, r, next[i]);
        vias[j][i] = res;
        if (!Number.isFinite(res.d) || res.d > bound) continue;
        const score = prev.cands[j].score - Math.abs(res.d - straight) / BETA_M;
        if (score > next[i].score) {
          next[i].score = score;
          next[i].back = j;
          next[i].stepM = res.d;
        }
      }
    }

    let any = false;
    let top = -Infinity;
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (c.back < 0) continue;
      any = true;
      c.score += emission(c.dist, fix.sigma);
      const v = vias[c.back][i]!;
      c.path = pathTo(this.g, reaches[c.back]!, c, v.via);
      if (c.score > top) top = c.score;
    }
    if (!any) return false;

    // Keep the numbers near zero; only differences matter.
    const kept = next.filter((c) => c.back >= 0);
    for (const c of kept) c.score -= top;
    // Back pointers index the previous layer, which is unchanged — safe to
    // drop the unreachable candidates from this one.
    this.layers.push({ fix, cands: kept });
    return true;
  }

  private backtrack(): Cand[] {
    const out: Cand[] = new Array(this.layers.length);
    const last = this.layers[this.layers.length - 1];
    let c = last.cands.reduce((a, b) => (b.score > a.score ? b : a));
    for (let i = this.layers.length - 1; i >= 0; i--) {
      out[i] = c;
      if (i > 0) c = this.layers[i - 1].cands[c.back];
    }
    return out;
  }

  /**
   * Fixed-lag smoothing. Anything older than LAG_S has seen a minute of
   * future fixes, which is enough to be sure which road it was on — so it
   * joins the permanent trail and the window slides forward.
   */
  private settle() {
    const newest = this.layers[this.layers.length - 1].fix.t;
    if (this.layers.length < 3 || newest - this.layers[1].fix.t <= LAG_S * 1000) return;

    const chosen = this.backtrack();
    let k = 1;
    while (k < this.layers.length - 1 && newest - this.layers[k].fix.t > LAG_S * 1000) k++;
    // Layers 0..k-1 settle. Layer k-1 becomes the new root.
    const root = chosen[0];
    const pts: LngLat[] = [toLngLat(this.g, root.x, root.y)];
    for (let i = 1; i < k; i++) {
      const p = chosen[i].path;
      if (p) for (let q = 1; q < p.length; q++) pts.push(toLngLat(this.g, p[q][0], p[q][1]));
    }
    this.appendRoad(pts, this.layers[0].fix.t, this.layers[k - 1].fix.t);

    const keep = chosen[k - 1];
    const rootLayer: Layer = {
      fix: this.layers[k - 1].fix,
      cands: [{ ...keep, score: 0, back: -1, path: null }],
    };
    // Every surviving layer's back pointers index the layer before it, and
    // that layer is about to lose the candidates the settled choice has ruled
    // out. Walk forward re-indexing, keeping only descendants of the choice.
    // The best path always survives: it runs through the choice by definition.
    const layers: Layer[] = [rootLayer];
    let map = new Map<number, number>([[chosen[k].back, 0]]);
    for (let i = k; i < this.layers.length; i++) {
      const L = this.layers[i];
      const next = new Map<number, number>();
      const cands: Cand[] = [];
      L.cands.forEach((c, idx) => {
        const b = map.get(c.back);
        if (b === undefined) return;
        next.set(idx, cands.length);
        cands.push({ ...c, back: b });
      });
      layers.push({ fix: L.fix, cands });
      map = next;
    }
    this.layers = layers;
  }

  /** End the current chain: settle every layer into the trail. */
  private finish() {
    if (!this.layers.length) return;
    const chosen = this.backtrack();
    const pts: LngLat[] = [toLngLat(this.g, chosen[0].x, chosen[0].y)];
    for (let i = 1; i < chosen.length; i++) {
      const p = chosen[i].path;
      if (p) for (let q = 1; q < p.length; q++) pts.push(toLngLat(this.g, p[q][0], p[q][1]));
    }
    this.appendRoad(pts, this.layers[0].fix.t, this.layers[this.layers.length - 1].fix.t);
    this.layers = [];
    this.tailCache = null;
  }

  // ---------------------------------------------------------------- trail

  private last(): TrailSeg | undefined { return this.committed[this.committed.length - 1]; }

  /**
   * Add settled road geometry. Continues the previous road segment when it
   * picks up where that one left off; otherwise starts a new one, joined to
   * the old by a straight 'gps' link if the silence between was short — so a
   * brief break in matching shows as a short dashed hop, and a real dead zone
   * as an honest gap.
   */
  private appendRoad(pts: LngLat[], t0: number, t1: number) {
    pts = dedupe(pts);
    if (!pts.length) return;
    const last = this.last();
    if (last && last.kind === 'road' && near(last.pts[last.pts.length - 1], pts[0])) {
      const add = pts.slice(1);
      last.pts.push(...add);
      last.t1 = t1;
      this.committedPts += add.length;
      return;
    }
    if (last && t0 - last.t1 <= GAP_S * 1000) {
      const end = last.pts[last.pts.length - 1];
      if (last.kind === 'gps') { last.pts.push(pts[0]); this.committedPts++; }
      else { this.committed.push({ kind: 'gps', pts: [end, pts[0]], t1: t0 }); this.committedPts += 2; }
    }
    this.committed.push({ kind: 'road', pts, t1 });
    this.committedPts += pts.length;
  }

  private appendGps(p: LngLat, t: number) {
    const last = this.last();
    if (last && t - last.t1 <= GAP_S * 1000) {
      if (last.kind === 'gps') { last.pts.push(p); last.t1 = t; this.committedPts++; return; }
      this.committed.push({ kind: 'gps', pts: [last.pts[last.pts.length - 1], p], t1: t });
      this.committedPts += 2;
      return;
    }
    this.committed.push({ kind: 'gps', pts: [p], t1: t });
    this.committedPts++;
  }
}

// ------------------------------------------------------------------ helpers

/**
 * How likely a fix is, given the bus is at a road position `d` metres away.
 *
 * Gaussian near the road, linear beyond two sigma (a Huber loss). The pure
 * Gaussian punishes a 40 m excursion a hundred times harder than a 4 m one,
 * so a handful of multipath fixes — the recorded ride has a run of five,
 * forty metres off, right after a tunnel-like gap — was enough to drag the
 * match down a village lane the bus never entered. With a linear tail, a few
 * bad fixes cost something but cannot outvote the fact that the bus has to
 * be able to drive from one position to the next.
 */
const emission = (d: number, sigma: number) => {
  const z = d / sigma;
  return z <= 2 ? -0.5 * z * z : -(2 * z - 2);
};

/** ~1 m apart counts as the same point. */
function near(a: LngLat, b: LngLat) {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

function dedupe(pts: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of pts) if (!out.length || !near(out[out.length - 1], p)) out.push(p);
  return out;
}

/** Direction of the last few metres of a path, degrees. Null if it barely moved. */
function headingOf(path: [number, number][] | null): number | null {
  if (!path || path.length < 2) return null;
  const end = path[path.length - 1];
  for (let i = path.length - 2; i >= 0; i--) {
    const dx = end[0] - path[i][0], dy = end[1] - path[i][1];
    if (Math.hypot(dx, dy) >= 5) return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }
  return null;
}

// ------------------------------------------------------------- no road data

/** What the engine needs from a path tracker, road-matched or not. */
export interface PathTracker {
  readonly committed: TrailSeg[];
  committedPts: number;
  current: MatchedPos | null;
  push(t: number, lng: number, lat: number, acc: number | null | undefined): MatchedPos;
  tail(): LngLat[];
  close(): void;
  restore(segs: TrailSeg[]): void;
}

/**
 * The stand-in for a route whose road graph has not been built yet.
 *
 * Draws the fixes as they are — joined by straight lines, labelled 'gps' so
 * the map shows them as unverified — and still reports the REAL position.
 * Strictly worse than matching, strictly better than the old behaviour of
 * pinning the bus to the planned line whatever it was actually doing.
 */
export class RawTracker implements PathTracker {
  readonly committed: TrailSeg[] = [];
  committedPts = 0;
  current: MatchedPos | null = null;
  private lastHeadingFrom: { lng: number; lat: number } | null = null;
  private heading: number | null = null;

  push(t: number, lng: number, lat: number): MatchedPos {
    const prev = this.current;
    const stepM = prev ? metres(prev.lng, prev.lat, lng, lat) : null;
    // Heading from fixes at least 10 m apart — closer than that and the noise
    // is as large as the movement.
    const from = this.lastHeadingFrom;
    if (!from) this.lastHeadingFrom = { lng, lat };
    else if (metres(from.lng, from.lat, lng, lat) >= 10) {
      this.heading = bearingDeg(from.lng, from.lat, lng, lat);
      this.lastHeadingFrom = { lng, lat };
    }
    const last = this.committed[this.committed.length - 1];
    if (last && t - last.t1 <= GAP_S * 1000) {
      if (!stepM || stepM >= MIN_STEP_M) { last.pts.push([lng, lat]); this.committedPts++; }
      last.t1 = t;
    } else {
      this.committed.push({ kind: 'gps', pts: [[lng, lat]], t1: t });
      this.committedPts++;
    }
    this.current = { lng, lat, x: 0, y: 0, onRoad: false, stepM, heading: this.heading, t };
    return this.current;
  }

  tail(): LngLat[] { return []; }
  close() { /* nothing pending */ }
  restore(segs: TrailSeg[]) {
    this.committed.length = 0;
    this.committed.push(...segs);
    this.committedPts = segs.reduce((n, s) => n + s.pts.length, 0);
  }
}

function metres(lng1: number, lat1: number, lng2: number, lat2: number) {
  const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110574);
}

function bearingDeg(lng1: number, lat1: number, lng2: number, lat2: number) {
  const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
  return ((Math.atan2((lng2 - lng1) * kx, (lat2 - lat1) * 110574) * 180) / Math.PI + 360) % 360;
}
