import { engine } from './engine';
import { getRoute } from './network';
import {
  runningTrips, beat, recordStopEvents, closeTrip, type Direction,
} from './trip-store';
import { notifyForTrip } from './push';
import { sql } from './db';

/**
 * The one background job on the server.
 *
 * Three things have to happen on a timer, and they all need the same data, so
 * they share a tick rather than each polling the engine separately:
 *
 *   1. mirror every live position to the database, so a restart does not lose
 *      the bus
 *   2. tell students whose stop is coming up
 *   3. raise and clear the alerts the transport office sees
 *
 * It starts itself on the first API request rather than at import time.
 * Next builds pages in a separate process, and a timer started during a build
 * would run against a database the build has no business touching.
 */

const TICK_MS = 15_000;
/** Past this with no fix, the bus is not being tracked any more. */
const STALE_MS = 4 * 60_000;

let booted: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __busLive: { booted: Promise<void> | null; timer: ReturnType<typeof setInterval> | null } | undefined;
}

export function ensureLive(): Promise<void> {
  const g = globalThis.__busLive ?? (globalThis.__busLive = { booted: null, timer: null });
  if (g.booted) return g.booted;
  g.booted = boot().catch((e) => {
    console.error('[live] boot failed:', (e as Error).message);
    // Clear it so the next request tries again rather than the server running
    // blind for the rest of its life because one query timed out at startup.
    g.booted = null;
  });
  booted = g.booted;
  return g.booted;
}

async function boot() {
  await rehydrate();
  const g = globalThis.__busLive!;
  if (g.timer) clearInterval(g.timer);
  g.timer = setInterval(() => { void tick(); }, TICK_MS);
  timer = g.timer;
  console.log('[live] running');
}

/** Put trips the database still thinks are running back into the engine. */
async function rehydrate() {
  const open = await runningTrips();
  for (const t of open) {
    const key = t.routeId;
    if (engine.view(key)?.trip) continue;          // already in memory
    if (t.distAlongM == null || t.lat == null || t.lng == null) continue;

    // Something left running from yesterday is not a bus, it is a driver who
    // forgot. Close it rather than resurrect it.
    const age = Date.now() - (t.lastFixAt ?? t.startedAt);
    if (age > 6 * 3600_000) { await closeTrip(t.id, 'abandoned'); continue; }

    engine.restore(key, {
      id: String(t.id),
      startedAt: t.startedAt,
      distAlongM: t.distAlongM,
      speedMps: t.speedMps ?? 0,
      lat: t.lat,
      lng: t.lng,
      bearing: t.bearing ?? 0,
      lastFixAt: t.lastFixAt ?? t.startedAt,
    });
    console.log(`[live] restored ${key} at ${(t.distAlongM / 1000).toFixed(1)} km`);
  }
}

async function tick() {
  try {
    for (const { key, trip } of engine.liveTrips()) {
      const view = engine.view(key);
      if (!view?.trip) continue;
      const tripId = Number(trip.id);
      if (!Number.isFinite(tripId)) continue;     // a replay, not a real run

      const routeId = key;
      const direction: Direction = 'outbound';

      await beat(tripId, {
        distAlongM: view.trip.distAlongM,
        lat: view.trip.lat,
        lng: view.trip.lng,
        speedMps: view.trip.speedMps,
        bearing: view.trip.bearing,
        fixAt: trip.lastFixAt || Date.now(),
        fixes: view.trip.pingCount,
      });

      const route = getRoute(key);
      if (route) {
        const schedule = new Map(route.stops.map((s) => [s.id, s.schedOffsetS]));
        await recordStopEvents(tripId, routeId, direction, view.events, schedule, trip.startedAt);
      }

      await notifyForTrip(tripId, routeId, direction, view);

      // No fix for minutes means the phone died, lost signal, or the app was
      // swiped away. Stop pretending we know where the bus is.
      //
      // Never while a demo is mid-run: the replay feeds in bursts and a slow
      // stretch of the trace could look like silence, which is why a demo
      // appeared to cut itself off halfway.
      if (!engine.isReplaying(key)
          && trip.lastSeenAt && Date.now() - trip.lastSeenAt > STALE_MS) {
        engine.end(key);
        await closeTrip(tripId, 'abandoned');
        console.log(`[live] ${key} went quiet — closed`);
      }
    }

    await sql("DELETE FROM waiting WHERE at < now() - interval '45 minutes'");
  } catch (e) {
    // A tick that throws must not kill the interval, or everything above
    // silently stops for the rest of the process's life.
    console.error('[live] tick:', (e as Error).message);
  }
}

export { timer as _liveTimer, booted as _liveBooted };
