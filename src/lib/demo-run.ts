import { getRoute, type LoadedRoute } from './network';
import { getReferenceTrip } from './network';

/**
 * A bus you can show someone, without putting a phone on a bus.
 *
 * Demonstrating this app has a chicken-and-egg problem: the thing worth
 * showing is a bus moving down a road, and there is no bus at 4pm in a
 * meeting room. Route 1 has a recorded ride we can replay — that is the real
 * thing, GPS noise and railway gate and all. Routes 2 and 3 have never been
 * driven with a recorder, so for those we drive the road line ourselves.
 *
 * The synthetic version is honest about what it is: it follows the actual
 * road at the actual scheduled pace, pauses at stops because a real bus does,
 * and adds a little GPS noise because a clean track looks fake to anyone who
 * has seen a real one. It is a demonstration, not a simulation — nobody
 * should mistake the ETAs it produces for measurements.
 *
 * Remove this file and the two call sites to take demo mode out entirely.
 */

/**
 * `t` is SECONDS FROM THE START OF THE RUN, not an epoch time.
 *
 * That is the shape the recorded trace uses and the shape the replay expects.
 * Emitting epoch milliseconds here made the engine believe the bus had set
 * off decades in the future: the arrival time came out as 147 minutes, the
 * delay as 974 minutes late, and the run fell over partway through.
 */
export interface TracePoint { t: number; lat: number; lng: number; spd: number; acc: number }

/** Metres between successive synthetic fixes. One per second at road speed. */
const STEP_HZ = 1;
/** How long the bus sits at a stop. */
const DWELL_S = 18;

function cumulative(shape: [number, number][]): number[] {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const cum = [0];
  for (let i = 1; i < shape.length; i++) {
    const [ax, ay] = shape[i - 1];
    const [bx, by] = shape[i];
    const p1 = rad(ay); const p2 = rad(by);
    const x = Math.sin(rad(by - ay) / 2) ** 2
      + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(bx - ax) / 2) ** 2;
    cum.push(cum[i - 1] + 2 * R * Math.asin(Math.sqrt(x)));
  }
  return cum;
}

function pointAt(shape: [number, number][], cum: number[], d: number): [number, number] {
  if (d <= 0) return shape[0];
  if (d >= cum[cum.length - 1]) return shape[shape.length - 1];
  let lo = 0; let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const f = (d - cum[lo]) / span;
  return [shape[lo][0] + f * (shape[hi][0] - shape[lo][0]),
          shape[lo][1] + f * (shape[hi][1] - shape[lo][1])];
}

/**
 * Builds a second-by-second trace along the route.
 *
 * Pace comes from the route's own profile, so the bus is slow where the
 * timetable says it is slow — through the villages, quick on the bypass —
 * rather than gliding at a constant speed that no bus has ever driven.
 */
export function syntheticTrace(route: LoadedRoute): TracePoint[] {
  const cum = cumulative(route.shape);
  const total = cum[cum.length - 1];
  const profile = route.profile?.length ? route.profile : null;

  /** Seconds into the run at a given distance, from the timetable. */
  const timeAt = (d: number): number => {
    if (!profile) return (d / total) * route.durationS;
    let lo = profile[0]; let hi = profile[profile.length - 1];
    for (let i = 0; i < profile.length - 1; i++) {
      if (d >= profile[i].d && d <= profile[i + 1].d) { lo = profile[i]; hi = profile[i + 1]; break; }
    }
    const span = hi.d - lo.d || 1;
    return lo.t + ((d - lo.d) / span) * (hi.t - lo.t);
  };

  const stops = [...route.stops].sort((a, b) => a.distAlongM - b.distAlongM);
  const out: TracePoint[] = [];

  let elapsed = 0;
  let nextStop = 0;

  for (let d = 0; d <= total; d += 0) {
    // Pace at this point, from the profile, floored so a flat stretch of the
    // timetable cannot divide by zero and stall the bus forever.
    const ahead = Math.min(total, d + 50);
    const dt = Math.max(0.6, timeAt(ahead) - timeAt(d));
    const speed = Math.max(2.5, (ahead - d) / dt);

    const [lng, lat] = pointAt(route.shape, cum, d);
    // Real GPS wanders. A perfectly clean track is the one thing that makes
    // a demo look like a cartoon to anyone who has watched a real trace.
    const jitter = () => (Math.random() - 0.5) * 0.000045;

    out.push({
      t: elapsed,
      lat: lat + jitter(),
      lng: lng + jitter(),
      spd: Number(speed.toFixed(2)),
      acc: 5 + Math.random() * 7,
    });

    elapsed += 1 / STEP_HZ;
    d += speed / STEP_HZ;

    // Sit at the stop, like a bus.
    while (nextStop < stops.length && d >= stops[nextStop].distAlongM) {
      const [slng, slat] = pointAt(route.shape, cum, stops[nextStop].distAlongM);
      for (let k = 0; k < DWELL_S; k++) {
        out.push({
          t: elapsed,
          lat: slat + jitter(), lng: slng + jitter(),
          spd: 0, acc: 5 + Math.random() * 5,
        });
        elapsed += 1;
      }
      nextStop++;
    }
  }

  return out;
}

/**
 * The trace to replay for a route: the recorded one if we have it, otherwise
 * a synthetic drive down the same road.
 */
export function demoTrace(routeKey: string): { points: TracePoint[]; source: 'recorded' | 'synthetic' } | null {
  const recorded = getReferenceTrip(routeKey);
  if (recorded?.points?.length) {
    return { points: recorded.points, source: 'recorded' };
  }
  const route = getRoute(routeKey);
  if (!route) return null;
  return { points: syntheticTrace(route), source: 'synthetic' };
}
