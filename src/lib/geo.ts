/**
 * Pure geometry. Shared by the server engine and the browser, so it must not
 * touch fs, window, or any runtime-specific API.
 *
 * The central idea of this project: a bus on a fixed route has ONE meaningful
 * coordinate — how far along the route it is. Two noisy numbers (lat, lng)
 * collapse into one clean scalar, and every question the app asks ("which stop
 * is next", "has it passed me", "how far to go") becomes arithmetic.
 */

export type LngLat = [number, number];
export interface Point { lat: number; lng: number }

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Cumulative distance in metres at each vertex. Computed once per route. */
export function cumulative(shape: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < shape.length; i++) {
    cum.push(cum[i - 1] + haversine(
      { lng: shape[i - 1][0], lat: shape[i - 1][1] },
      { lng: shape[i][0], lat: shape[i][1] },
    ));
  }
  return cum;
}

/** Largest index with cum[i] <= d. */
function lowerBound(cum: number[], d: number): number {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  return lo;
}

/** The lng/lat sitting `d` metres along the route. */
export function atDistance(shape: LngLat[], cum: number[], d: number): Point {
  const total = cum[cum.length - 1];
  d = Math.max(0, Math.min(total, d));
  const lo = lowerBound(cum, d);
  const hi = Math.min(lo + 1, shape.length - 1);
  const span = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / span;
  return {
    lng: shape[lo][0] + t * (shape[hi][0] - shape[lo][0]),
    lat: shape[lo][1] + t * (shape[hi][1] - shape[lo][1]),
  };
}

/** Compass bearing of the route itself at distance `d` — points the bus icon. */
export function bearingAt(shape: LngLat[], cum: number[], d: number): number {
  const a = atDistance(shape, cum, Math.max(0, d - 25));
  const b = atDistance(shape, cum, Math.min(cum[cum.length - 1], d + 25));
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export interface Projection {
  distAlong: number;
  lat: number;
  lng: number;
  offsetM: number; // perpendicular distance from the route — a quality signal
}

/**
 * Project a GPS fix onto the route.
 *
 * The search window around the last known position is deliberately ASYMMETRIC,
 * and that asymmetry is the whole trick.
 *
 * Real routes double back: this one detours into Pichatur and returns down the
 * same road. With a symmetric window, a fix on the outbound leg happily matches
 * the return leg a kilometre further along — the position lurches backwards, the
 * fix gets thrown out as impossible, the estimate stalls, and every later fix
 * looks further off the road than the last. A single overlap quietly destroys
 * the whole trip.
 *
 * A bus can only travel forward, and only as far as physics allows in the time
 * since the last fix. Encoding both facts makes the wrong leg unreachable:
 *   `back` — a little slack for GPS noise and filter lag
 *   `fwd`  — bounded by top speed times elapsed time
 */
export function projectOnto(
  shape: LngLat[],
  cum: number[],
  p: Point,
  near?: number | null,
  back = 80,
  fwd = 400,
): Projection {
  let from = 1;
  let to = shape.length - 1;
  if (near != null) {
    from = Math.max(1, lowerBound(cum, near - back));
    to = Math.min(shape.length - 1, lowerBound(cum, near + fwd) + 1);
  }

  // Local equirectangular projection — accurate to well under a metre at the
  // scale of a single road segment, and far cheaper than repeated haversines.
  const kLat = 111320;
  const kLng = 111320 * Math.cos(rad(p.lat));

  let best: Projection & { d2: number } = {
    d2: Infinity, distAlong: near ?? 0, lat: p.lat, lng: p.lng, offsetM: 0,
  };

  for (let i = from; i <= to; i++) {
    const [ax, ay] = shape[i - 1];
    const [bx, by] = shape[i];
    const axm = (ax - p.lng) * kLng, aym = (ay - p.lat) * kLat;
    const bxm = (bx - p.lng) * kLng, bym = (by - p.lat) * kLat;
    const dx = bxm - axm, dy = bym - aym;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(axm * dx + aym * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = axm + t * dx, cy = aym + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best.d2) {
      best = {
        d2,
        distAlong: cum[i - 1] + t * (cum[i] - cum[i - 1]),
        lng: ax + t * (bx - ax),
        lat: ay + t * (by - ay),
        offsetM: Math.sqrt(d2),
      };
    }
  }
  const { d2, ...out } = best;
  return out;
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export interface PlanHit {
  /** Where on the planned route, metres from the start. */
  distAlong: number;
  /** How far the point is from the planned line there. */
  offsetM: number;
  /** Which way the planned route runs at that spot, degrees. */
  bearing: number;
}

/**
 * Every place in [fromD, toD] where the planned route passes within
 * `maxOffset` of a point — one hit per pass, in route order.
 *
 * "Per pass" is the part that matters. An out-and-back spur runs down a road
 * and back up the SAME road, so a bus standing on it is close to the plan
 * twice: once on the way in, once on the way out. projectOnto() answers with
 * whichever is nearer and cannot tell them apart. This answers with both, and
 * with the direction the plan was travelling on each — which is what does
 * tell them apart, because the two passes run in opposite directions.
 *
 * A pass is a run of consecutive segments within range. Given the bus's
 * `heading`, a segment running the other way does not count as in range at
 * all — so near a turnaround, where both legs are close, the leg the bus is
 * NOT on simply is not a candidate, however near it is. Without a heading
 * (a parked bus) every pass counts, and a run is cut where the line turns
 * back on itself so the legs still come back as separate hits.
 */
export function planHits(
  shape: LngLat[], cum: number[], p: Point,
  fromD: number, toD: number, maxOffset: number,
  heading: number | null = null, headingTol = 70,
): PlanHit[] {
  const from = Math.max(1, lowerBound(cum, Math.max(0, fromD)));
  const to = Math.min(shape.length - 1, lowerBound(cum, toD) + 1);
  const kLat = 111320;
  const kLng = 111320 * Math.cos(rad(p.lat));

  const hits: PlanHit[] = [];
  let run: PlanHit | null = null;
  let runBearing = 0;

  for (let i = from; i <= to; i++) {
    const [ax, ay] = shape[i - 1];
    const [bx, by] = shape[i];
    const axm = (ax - p.lng) * kLng, aym = (ay - p.lat) * kLat;
    const bxm = (bx - p.lng) * kLng, bym = (by - p.lat) * kLat;
    const dx = bxm - axm, dy = bym - aym;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let t = -(axm * dx + aym * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const off = Math.hypot(axm + t * dx, aym + t * dy);
    const bearing = (deg(Math.atan2(dx, dy)) + 360) % 360;

    if (off > maxOffset || (heading != null && angleDiff(bearing, heading) > headingTol)) {
      if (run) { hits.push(run); run = null; }
      continue;
    }
    if (run && angleDiff(bearing, runBearing) > 100) {
      hits.push(run); run = null;
    }
    const d = cum[i - 1] + t * (cum[i] - cum[i - 1]);
    if (d < fromD || d > toD) continue;
    if (!run || off < run.offsetM) {
      run = { distAlong: d, offsetM: off, bearing };
    }
    runBearing = bearing;
  }
  if (run) hits.push(run);
  return hits;
}

/** Smallest angle between two compass bearings, 0-180. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}
