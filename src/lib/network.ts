import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cumulative } from './geo';
import type { Network, RouteData } from './types';

const DATA = join(process.cwd(), 'data');

export interface LoadedRoute extends RouteData {
  /** Cumulative distance per vertex — precomputed once, reused every ping. */
  cum: number[];
}

let networkCache: Network | null = null;
const routeCache = new Map<string, LoadedRoute>();

export function getNetwork(): Network {
  if (networkCache) return networkCache;
  const path = join(DATA, 'network.json');
  if (!existsSync(path)) {
    throw new Error('data/network.json is missing — run `npm run seed` first.');
  }
  networkCache = JSON.parse(readFileSync(path, 'utf8')) as Network;
  return networkCache;
}

/**
 * The afternoon run, derived from the morning one.
 *
 * The bus home is the same road travelled backwards: same tarmac, same stops,
 * opposite order. Rather than teach the engine to run a route in reverse —
 * every projection, every crossing test, every ETA would need a sign — we
 * hand it a route that genuinely goes the other way. Reverse the shape,
 * reverse the stops, measure distances from the new start, and the engine
 * does not need to know a return journey exists.
 *
 * The timetable mirrors too: the stop served first in the morning is served
 * last on the way home, so its offset becomes (total - its own). That is
 * exactly the arithmetic the drop times on the student's screen already use,
 * which means the two can never disagree.
 */
function reverseRoute(f: RouteData, returnStart: string): RouteData {
  const shape = [...f.shape].reverse();
  const total = f.stops[f.stops.length - 1]?.schedOffsetS ?? f.durationS;

  const stops = [...f.stops].reverse().map((s, i) => ({
    ...s,
    seq: i,
    distAlongM: Math.max(0, f.lengthM - s.distAlongM),
    schedOffsetS: Math.max(0, total - s.schedOffsetS),
  }));

  // Rebuild the time-vs-distance curve across the reversed stops.
  const profile: { d: number; t: number }[] = [];
  const SAMPLES = 400;
  for (let k = 0; k <= SAMPLES; k++) {
    const d = (f.lengthM * k) / SAMPLES;
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (d >= stops[i].distAlongM && d <= stops[i + 1].distAlongM) {
        a = stops[i]; b = stops[i + 1]; break;
      }
    }
    const span = b.distAlongM - a.distAlongM;
    const frac = span === 0 ? 0 : (d - a.distAlongM) / span;
    profile.push({
      d: Math.round(d),
      t: Math.round(a.schedOffsetS + frac * (b.schedOffsetS - a.schedOffsetS)),
    });
  }

  return {
    ...f,
    id: `${f.id}${INBOUND}`,
    name: `Campus — ${f.name.split('—')[0].trim()}`,
    short: `${f.short} (home)`,
    schedStart: returnStart,
    durationS: total,
    shape,
    stops,
    profile,
  };
}

/** Suffix that marks the afternoon variant of a route. */
export const INBOUND = '@in';

export const engineKey = (routeId: string, direction: 'outbound' | 'inbound') =>
  (direction === 'inbound' ? `${routeId}${INBOUND}` : routeId);

export const baseRouteId = (key: string) =>
  (key.endsWith(INBOUND) ? key.slice(0, -INBOUND.length) : key);

export function getRoute(id: string, returnStart = '16:45'): LoadedRoute | null {
  const cached = routeCache.get(id);
  if (cached) return cached;

  if (id.endsWith(INBOUND)) {
    const forward = getRoute(baseRouteId(id));
    if (!forward) return null;
    const { cum: _drop, ...plain } = forward;
    const rev = reverseRoute(plain, returnStart);
    const loaded: LoadedRoute = { ...rev, cum: cumulative(rev.shape) };
    routeCache.set(id, loaded);
    return loaded;
  }

  const path = join(DATA, 'routes', `${id}.json`);
  if (!existsSync(path)) return null;

  const raw = JSON.parse(readFileSync(path, 'utf8')) as RouteData;
  const loaded: LoadedRoute = { ...raw, cum: cumulative(raw.shape) };
  routeCache.set(id, loaded);
  return loaded;
}

export function allRouteIds(): string[] {
  const dir = join(DATA, 'routes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.trip.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/** The recorded 1 Hz trace used by replay mode. */
export function getReferenceTrip(
  routeId: string,
): { durationS: number; points: { t: number; lat: number; lng: number; spd: number; acc: number }[] } | null {
  const path = join(DATA, 'routes', `${routeId}.trip.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
