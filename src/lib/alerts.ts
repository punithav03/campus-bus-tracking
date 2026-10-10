import { sql } from './db';
import { engine } from './engine';
import { engineKey } from './network';
import { scheduledRoutes } from './live';

/**
 * What the transport office needs to know without watching the screen.
 *
 * The office's real question at 7:30 is not "where is bus 2" — it is "has
 * anything gone wrong this morning". So rather than a dashboard they have to
 * read, this raises a short list of problems and clears each one the moment
 * it stops being true.
 *
 * Alerts are stored, not computed on demand, for one reason: "the bus has
 * been late for twenty minutes" is a different fact from "the bus is late",
 * and only a row with a raised_at can tell you which.
 */

type Kind = 'not_started' | 'late' | 'signal_lost';

/** How late a start has to be before it is worth interrupting someone. */
const GRACE_MIN = 10;
/** Running behind by this much is a problem, not traffic. */
const LATE_S = 15 * 60;
/** Silence this long from a bus that is supposed to be running. */
const QUIET_MS = 3 * 60_000;

function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  return ist.getHours() * 60 + ist.getMinutes();
}

async function raise(routeId: string, kind: Kind, severity: 'warn' | 'bad', message: string) {
  // The partial unique index makes this idempotent: an alert already open for
  // this route and kind simply has its wording refreshed, so "12 minutes late"
  // becomes "18 minutes late" without a second row appearing.
  await sql(
    `INSERT INTO alerts (route_id, kind, severity, message)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (route_id, kind) WHERE cleared_at IS NULL
     DO UPDATE SET message = EXCLUDED.message, severity = EXCLUDED.severity`,
    [routeId, kind, severity, message],
  );
}

async function clear(routeId: string, kind: Kind) {
  await sql(
    'UPDATE alerts SET cleared_at = now() WHERE route_id=$1 AND kind=$2 AND cleared_at IS NULL',
    [routeId, kind],
  );
}

export async function sweepAlerts(): Promise<void> {
  const nowMin = istMinutes();

  for (const r of scheduledRoutes()) {
    const key = engineKey(r.id, r.direction);
    const view = engine.view(key);
    const trip = view?.trip ?? null;
    const label = r.direction === 'inbound' ? `${r.name} (home)` : r.name;

    // ---- should have started by now ------------------------------------
    // Only inside a window. Outside it the bus is not late, it is finished,
    // and an alert that never clears is one the office learns to ignore.
    const due = nowMin >= r.startMin + GRACE_MIN && nowMin <= r.startMin + 150;
    if (due && !trip) {
      const by = nowMin - r.startMin;
      await raise(r.id, 'not_started', by > 25 ? 'bad' : 'warn',
        `${label} has not started — scheduled ${fmt(r.startMin)}, now ${by} min late`);
    } else {
      await clear(r.id, 'not_started');
    }

    // ---- running, but badly behind -------------------------------------
    if (trip && trip.delayS > LATE_S) {
      await raise(r.id, 'late', trip.delayS > 30 * 60 ? 'bad' : 'warn',
        `${label} is running ${Math.round(trip.delayS / 60)} min late`);
    } else {
      await clear(r.id, 'late');
    }

    // ---- was running, has gone quiet ------------------------------------
    // Distinct from "not started": the driver did everything right and the
    // phone stopped reporting, which is a different conversation.
    const quiet = trip && view!.trip!.ageS * 1000 > QUIET_MS;
    if (quiet) {
      await raise(r.id, 'signal_lost', 'warn',
        `${label} — no signal for ${Math.round(view!.trip!.ageS / 60)} min`);
    } else {
      await clear(r.id, 'signal_lost');
    }
  }
}

const fmt = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export interface OpenAlert {
  id: number; routeId: string; kind: Kind; severity: string;
  message: string; raisedAt: number;
}

export async function openAlerts(): Promise<OpenAlert[]> {
  const rows = await sql<{
    id: string; route_id: string; kind: string; severity: string;
    message: string; raised_at: string;
  }>(`SELECT id, route_id, kind, severity, message, raised_at
        FROM alerts WHERE cleared_at IS NULL
       ORDER BY severity DESC, raised_at`);
  return rows.map((r) => ({
    id: Number(r.id),
    routeId: r.route_id,
    kind: r.kind as Kind,
    severity: r.severity,
    message: r.message,
    raisedAt: new Date(r.raised_at).getTime(),
  }));
}
