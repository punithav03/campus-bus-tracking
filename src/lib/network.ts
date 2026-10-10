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

export function getRoute(id: string): LoadedRoute | null {
  const cached = routeCache.get(id);
  if (cached) return cached;

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
