import { engine } from './engine';
import { getRoute } from './network';
import {
  runningTrips, beat, recordStopEvents, closeTrip, savePath, loadPath, stopHistory, forgetPath,
  type Direction,
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
/**
 * Past this with no fix, the run is over: the phone died, or the driver went
 * home without pressing End.
 *
 * This used to be FOUR MINUTES, and that silently killed real runs. A bus
 * that drove through a five-minute dead zone had its trip closed behind its
 * back — and when the phone came back into signal with a pocketful of
 * buffered fixes, ingest refused every one of them, because they belonged to
 * a trip that was now finished. The rest of the morning, the bus was gone.
 *
 * The map does not need this to be honest: the freshness badge already says
 * "last seen 6 min ago" and the marker stops moving at 45 s. Closing the trip
 * is only about cleaning up, so it can afford to wait for a gap no dead zone
 * on these roads comes near.
 */
const STALE_MS = 45 * 60_000;

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

    // History and the trail come back too. Without them a restarted server
    // showed every stop behind the bus as merely "passed", forgot which were
    // skipped, and drew no line behind the bus at all.
    const route = getRoute(key);
    const [hist, trail] = await Promise.all([
      stopHistory(t.id).catch(() => ({ served: [], skipped: [] })),
      loadPath(t.id).catch(() => []),
    ]);
    const seqOf = new Map(route?.stops.map((s) => [s.id, s.seq]) ?? []);
    engine.restore(key, {
      id: String(t.id),
      startedAt: t.startedAt,
      distAlongM: t.distAlongM,
      speedMps: t.speedMps ?? 0,
      lat: t.lat,
      lng: t.lng,
      bearing: t.bearing ?? 0,
      lastFixAt: t.lastFixAt ?? t.startedAt,
      events: hist.served.filter((e) => seqOf.has(e.stopId)).map((e) => ({
        stopId: e.stopId, seq: seqOf.get(e.stopId)!, arrivedAt: e.reachedAt,
        departedAt: e.reachedAt, delayS: e.delayS ?? 0,
        // Not stored, and it only changes a word on screen. Unknown reads as
        // "went past", which never claims a pick-up we did not see.
        halted: false,
      })),
      skipped: hist.skipped.filter((id) => seqOf.has(id)).map((id) => seqOf.get(id)!),
      trail,
    });
    console.log(`[live] restored ${key} at ${(t.distAlongM / 1000).toFixed(1)} km` +
      ` (${hist.served.length} served, ${hist.skipped.length} skipped, ${trail.length} trail pieces)`);
  }
}

/** A stable made-up trip number for a demo replay (testing pushes only). */
function replayTripNo(id: string): number {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 900_000_000 + (h % 99_999_999);
}

async function tick() {
  try {
    for (const { key, trip } of engine.liveTrips()) {
      const view = engine.view(key);
      if (!view?.trip) continue;
      const tripId = Number(trip.id);
      if (!Number.isFinite(tripId)) {
        // A demo replay, not a real run: nothing is written for it. With
        // PUSH_ON_REPLAY=1 (testing only) its notifications still go out, under
        // a stable made-up trip number, so the live card can be tried any time.
        if (process.env.PUSH_ON_REPLAY === '1') {
          await notifyForTrip(replayTripNo(trip.id), key, 'outbound', view)
            .catch((e) => console.error('[live] replay push:', (e as Error).message));
        }
        continue;
      }

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
        const skipped = view.stops.filter((s) => s.state === 'skipped').map((s) => s.id);
        await recordStopEvents(tripId, routeId, direction, view.events, schedule, trip.startedAt, skipped);
      }
      // The trail is a nice-to-have next to the position, so a failure here
      // (say, the migration not yet applied) must not stop the rest.
      await savePath(tripId, trip.tracker.committed).catch((e) =>
        console.error('[live] trail:', (e as Error).message));

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
        await savePath(tripId, trip.tracker.committed).catch(() => {});
        await closeTrip(tripId, 'abandoned');
        forgetPath(tripId);
        console.log(`[live] ${key} went quiet — closed`);
      }
    }

    // A run that just ended — arrived, or the driver pressed End — is no
    // longer live, but its last moments are not written yet: the final
    // stretch of trail, and the stops decided skipped at the finish. Once.
    for (const { key, trip } of engine.unflushed()) {
      trip.flushed = true;
      const tripId = Number(trip.id);
      const view = engine.view(key);
      // The college arrival ENDS the trip, so this is the only tick that ever
      // sees it: tell the students here, or they are never told.
      if (view?.trip) {
        const no = Number.isFinite(tripId) ? tripId
          : process.env.PUSH_ON_REPLAY === '1' ? replayTripNo(trip.id) : null;
        if (no != null) {
          await notifyForTrip(no, key, 'outbound', view)
            .catch((e) => console.error('[live] final push:', (e as Error).message));
        }
      }
      if (!Number.isFinite(tripId)) continue;
      const route = getRoute(key);
      if (view && route) {
        const schedule = new Map(route.stops.map((s) => [s.id, s.schedOffsetS]));
        const skipped = view.stops.filter((s) => s.state === 'skipped').map((s) => s.id);
        await recordStopEvents(tripId, key, 'outbound', view.events, schedule, trip.startedAt, skipped);
      }
      await savePath(tripId, trip.tracker.committed).catch(() => {});
      forgetPath(tripId);
    }

    await sql("DELETE FROM waiting WHERE at < now() - interval '45 minutes'");
  } catch (e) {
    // A tick that throws must not kill the interval, or everything above
    // silently stops for the rest of the process's life.
    console.error('[live] tick:', (e as Error).message);
  }
}

export { timer as _liveTimer, booted as _liveBooted };
