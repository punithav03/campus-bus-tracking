import { sql, one } from './db';
import type { StopEvent } from './types';
import type { TrailSeg } from './matcher';

/**
 * The bridge between the engine's memory and the database.
 *
 * The engine keeps live state in memory, deliberately — a bus position is
 * worthless thirty seconds later and writing every GPS fix would be millions
 * of rows nobody reads. But "in memory" has a failure mode the driver cannot
 * see: a deploy, a crash, or the free tier idling makes the bus disappear
 * mid-route, and the first anyone knows is a student at a stop watching
 * nothing move.
 *
 * So the live position is mirrored here as a heartbeat — four columns,
 * overwritten in place every few seconds — and the engine rehydrates from it
 * on boot. Stop arrivals are appended properly, because those are the history
 * that makes the ETA model better over time.
 */

/**
 * Kept as a column and a type so the history already written stays readable,
 * but there is only one run. The college drives the route in the morning;
 * the afternoon trip was modelled before anyone asked for it, and an
 * unused direction threaded through every lookup was a steady source of
 * bugs — the student's own screen saying "not running" under a live bus
 * being the worst of them.
 */
export type Direction = 'outbound';

export interface OpenTrip {
  id: number;
  routeId: string;
  direction: Direction;
  driverId: string | null;
  startedAt: number;
  distAlongM: number | null;
  lat: number | null;
  lng: number | null;
  speedMps: number | null;
  bearing: number | null;
  lastFixAt: number | null;
  engineId: string | null;
}

interface Row {
  id: string; route_id: string; direction: string; driver_id: string | null;
  started_at: string; last_dist_m: string | null; last_lat: string | null;
  last_lng: string | null; last_speed_mps: string | null; last_bearing: string | null;
  last_fix_at: string | null; engine_id: string | null;
}

const num = (v: string | null) => (v == null ? null : Number(v));

const hydrate = (r: Row): OpenTrip => ({
  id: Number(r.id),
  routeId: r.route_id,
  direction: r.direction as Direction,
  driverId: r.driver_id,
  startedAt: new Date(r.started_at).getTime(),
  distAlongM: num(r.last_dist_m),
  lat: num(r.last_lat),
  lng: num(r.last_lng),
  speedMps: num(r.last_speed_mps),
  bearing: num(r.last_bearing),
  lastFixAt: r.last_fix_at ? new Date(r.last_fix_at).getTime() : null,
  engineId: r.engine_id,
});

const COLS = `id, route_id, direction, driver_id, started_at,
              last_dist_m, last_lat, last_lng, last_speed_mps, last_bearing,
              last_fix_at, engine_id`;

/**
 * Opens a trip, or returns the one already running.
 *
 * The unique index on (route_id, direction) where status='running' is what
 * actually prevents two phones broadcasting the same bus. Relying on a check
 * in application code would lose the race between two drivers both tapping
 * Start in the same second; the database cannot.
 */
export async function openTrip(
  routeId: string,
  direction: Direction,
  driverId: string | null,
  engineId: string,
): Promise<OpenTrip> {
  const existing = await one<Row>(
    `SELECT ${COLS} FROM trips
      WHERE route_id = $1 AND direction = $2 AND status = 'running'`,
    [routeId, direction],
  );
  if (existing) return hydrate(existing);

  const rows = await sql<Row>(
    `INSERT INTO trips (route_id, direction, driver_id, engine_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING
     RETURNING ${COLS}`,
    [routeId, direction, driverId, engineId],
  );
  if (rows[0]) return hydrate(rows[0]);

  // Lost the race — somebody else inserted between our check and our insert.
  const now = await one<Row>(
    `SELECT ${COLS} FROM trips
      WHERE route_id = $1 AND direction = $2 AND status = 'running'`,
    [routeId, direction],
  );
  if (!now) throw new Error('could not open a trip');
  return hydrate(now);
}

/** The heartbeat. Cheap, frequent, overwritten in place. */
export async function beat(
  tripId: number,
  p: { distAlongM: number; lat: number; lng: number; speedMps: number; bearing: number; fixAt: number; fixes: number },
): Promise<void> {
  await sql(
    `UPDATE trips SET last_dist_m=$2, last_lat=$3, last_lng=$4,
            last_speed_mps=$5, last_bearing=$6, last_fix_at=to_timestamp($7/1000.0),
            fixes=$8
      WHERE id=$1 AND status='running'`,
    [tripId, p.distAlongM, p.lat, p.lng, p.speedMps, p.bearing, p.fixAt, p.fixes],
  );
}

export async function closeTrip(tripId: number, status: 'finished' | 'abandoned' = 'finished') {
  await sql('UPDATE trips SET status=$2, ended_at=now() WHERE id=$1 AND status=$3',
    [tripId, status, 'running']);
}

/** Every trip still marked running — what a restarted server has to pick up. */
export async function runningTrips(): Promise<OpenTrip[]> {
  const rows = await sql<Row>(`SELECT ${COLS} FROM trips WHERE status='running'`);
  return rows.map(hydrate);
}

/**
 * Records a stop arrival, once.
 *
 * The primary key does the deduplication: the engine re-detects crossings
 * whenever it reprocesses, and without this a single stop would accumulate a
 * row per poll and poison the historical averages it exists to feed.
 */
export async function recordStopEvents(
  tripId: number, routeId: string, direction: Direction, events: StopEvent[],
  schedule: Map<string, number>, startedAt: number,
  skipped: string[] = [],
): Promise<void> {
  // A skipped stop is recorded too, without a time. Once only: the engine
  // never un-skips a stop, and a later real arrival would be a different fact
  // that the upsert below is allowed to overwrite.
  for (const stopId of skipped) {
    await sql(
      `INSERT INTO stop_events (trip_id, stop_id, route_id, direction, reached_at, delay_s, skipped)
       VALUES ($1,$2,$3,$4,NULL,NULL,true)
       ON CONFLICT (trip_id, stop_id) DO NOTHING`,
      [tripId, stopId, routeId, direction],
    );
  }
  for (const e of events) {
    if (!e.arrivedAt) continue;
    const sched = schedule.get(e.stopId);
    const delayS = sched == null ? null
      : Math.round((e.arrivedAt - startedAt) / 1000 - sched);
    await sql(
      `INSERT INTO stop_events (trip_id, stop_id, route_id, direction, reached_at, delay_s)
       VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6)
       ON CONFLICT (trip_id, stop_id) DO UPDATE
         SET reached_at = EXCLUDED.reached_at, delay_s = EXCLUDED.delay_s, skipped = false
         WHERE stop_events.skipped`,
      [tripId, e.stopId, routeId, direction, e.arrivedAt, delayS],
    );
  }
}

/**
 * Which way is the bus going right now?
 *
 * Decided by the clock, not asked of the driver. He has one job in the morning
 * and the same job in the afternoon, and making him also classify the trip is
 * a question whose wrong answer sends every student to the wrong side of the
 * route. Anything from midday on is the run home.
 */
export const directionNow = (): Direction => 'outbound';

/** Minutes since midnight in India. */
export function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/**
 * Stop history for a trip, for putting it back after a restart: which stops
 * were served and when, and which were skipped.
 */
export async function stopHistory(tripId: number): Promise<{
  served: { stopId: string; reachedAt: number; delayS: number | null }[];
  skipped: string[];
}> {
  const rows = await sql<{ stop_id: string; reached_at: string | null; delay_s: number | null; skipped: boolean }>(
    `SELECT stop_id, reached_at, delay_s, skipped FROM stop_events WHERE trip_id = $1`, [tripId]);
  return {
    served: rows.filter((r) => !r.skipped && r.reached_at)
      .map((r) => ({ stopId: r.stop_id, reachedAt: new Date(r.reached_at!).getTime(), delayS: r.delay_s })),
    skipped: rows.filter((r) => r.skipped).map((r) => r.stop_id),
  };
}

// ------------------------------------------------------------------ trail

const PIECE = 200;

/**
 * What has already been written, per trip: "seg:piece" -> point count. The
 * trail only grows at its end, so comparing lengths finds the one or two
 * pieces that changed since the last mirror and nothing else is rewritten.
 * Lost on restart, which only costs one full rewrite.
 */
const written = new Map<number, Map<string, number>>();

/** Mirror the trail so a restart does not wipe the line behind the bus. */
export async function savePath(tripId: number, segs: TrailSeg[]): Promise<void> {
  let done = written.get(tripId);
  if (!done) { done = new Map(); written.set(tripId, done); }
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    for (let p = 0; p * PIECE < seg.pts.length; p++) {
      // Each piece repeats the last point of the one before, so the pieces
      // join up into one line when drawn or reassembled.
      const from = Math.max(0, p * PIECE - (p > 0 ? 1 : 0));
      const pts = seg.pts.slice(from, (p + 1) * PIECE);
      const key = `${s}:${p}`;
      if (done.get(key) === pts.length) continue;
      await sql(
        `INSERT INTO trip_path (trip_id, seg, piece, kind, pts) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (trip_id, seg, piece) DO UPDATE SET pts = EXCLUDED.pts, kind = EXCLUDED.kind`,
        [tripId, s, p, seg.kind, JSON.stringify(pts.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]))],
      );
      done.set(key, pts.length);
    }
  }
}

/** The trail as saved, for a restarted server. Empty if there is none. */
export async function loadPath(tripId: number): Promise<TrailSeg[]> {
  const rows = await sql<{ seg: number; piece: number; kind: 'road' | 'gps'; pts: [number, number][] }>(
    `SELECT seg, piece, kind, pts FROM trip_path WHERE trip_id = $1 ORDER BY seg, piece`, [tripId]);
  const segs: TrailSeg[] = [];
  for (const r of rows) {
    let seg = segs[r.seg];
    if (!seg) { seg = { kind: r.kind, pts: [], t1: 0 }; segs[r.seg] = seg; }
    // Drop the repeated joining point when stitching pieces back together.
    seg.pts.push(...(r.piece > 0 ? r.pts.slice(1) : r.pts));
  }
  return segs.filter(Boolean);
}

/** Forget what was written for a trip that has ended. */
export function forgetPath(tripId: number) { written.delete(tripId); }
