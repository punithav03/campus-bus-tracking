import webpush from 'web-push';
import { sql } from './db';
import type { StateView } from './types';
import type { Direction } from './trip-store';

/**
 * Telling a student the bus is coming, without them opening anything.
 *
 * This is the whole point of the app finally working. Until now a student
 * still had to check their phone every two minutes — which is the same
 * problem as standing at the stop guessing, just with more steps. The walk
 * slider already promised "leave now fires this many minutes before the bus
 * reaches you". This is what makes that promise true.
 *
 * Three rules shape everything here:
 *
 *   NEVER TWICE. A duplicate "your bus is coming" is how an app gets its
 *   notifications switched off, permanently, by the person who most needed
 *   them. Deduplication is a primary key, not a flag in memory.
 *
 *   NEVER LATE. A notification that arrives after the bus has gone is worse
 *   than silence, because the student trusted it. Anything past the
 *   threshold is dropped rather than sent apologetically.
 *
 *   NEVER NOISY. Three kinds, total: it started, it is nearly at your stop,
 *   it reached the college. Nothing else earns an interruption.
 */

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com', pub, priv);
  configured = true;
  return true;
}

export type Kind = 'started' | 'approaching' | 'arrived';

interface Sub {
  endpoint: string; p256dh: string; auth: string;
  roll_no: string; lead_min: number;
}

/**
 * Sends one payload to one device.
 *
 * A 404 or 410 means the browser threw the subscription away — the student
 * cleared site data, or uninstalled. Those are not errors to retry; they are
 * rows to delete, and keeping them would mean pushing to the dead forever.
 */
async function deliver(sub: Sub, payload: object): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 300 },      // useless after five minutes; do not let it linger
    );
    await sql('UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE endpoint = $1',
      [sub.endpoint]);
    return true;
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) {
      await sql('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
    } else {
      await sql('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1',
        [sub.endpoint]);
      await sql('DELETE FROM push_subscriptions WHERE endpoint = $1 AND failures > 10',
        [sub.endpoint]);
    }
    return false;
  }
}

/**
 * Claims the right to send. Returns false if somebody already did.
 *
 * The insert IS the lock. Checking first and sending second would let two
 * ticks overlapping by a millisecond both decide they were first, and the
 * student gets told twice.
 */
async function claim(tripId: number, roll: string, kind: Kind): Promise<boolean> {
  const rows = await sql(
    `INSERT INTO notifications_sent (trip_id, roll_no, kind) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING roll_no`,
    [tripId, roll, kind],
  );
  return rows.length > 0;
}

async function subsFor(rolls: string[]): Promise<Map<string, Sub[]>> {
  if (!rolls.length) return new Map();
  const rows = await sql<Sub>(
    `SELECT endpoint, p256dh, auth, roll_no, lead_min
       FROM push_subscriptions WHERE roll_no = ANY($1)`,
    [rolls],
  );
  const out = new Map<string, Sub[]>();
  for (const r of rows) {
    const list = out.get(r.roll_no) ?? [];
    list.push(r);
    out.set(r.roll_no, list);
  }
  return out;
}

/**
 * Works through one running trip and tells whoever needs telling.
 *
 * Called from the live ticker every fifteen seconds. Almost every call does
 * nothing, which is correct — the interesting moment for any given student
 * happens once per trip.
 */
export async function notifyForTrip(
  tripId: number,
  routeId: string,
  direction: Direction,
  view: StateView,
): Promise<void> {
  if (!configure()) return;
  const trip = view.trip;
  if (!trip) return;

  // Everyone on this route who has asked to be told, with their own stop.
  const students = await sql<{ roll_no: string; name: string; stop_id: string | null }>(
    `SELECT s.roll_no, s.name, s.stop_id
       FROM students s
      WHERE s.route_id = $1 AND s.stop_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.roll_no = s.roll_no)`,
    [routeId],
  );
  if (!students.length) return;

  const subs = await subsFor(students.map((s) => s.roll_no));
  const byStop = new Map(view.stops.map((s) => [s.id, s]));
  const routeName = view.route.short || view.route.name;
  const home = direction === 'inbound';

  for (const st of students) {
    const mine = st.stop_id ? byStop.get(st.stop_id) : null;
    const devices = subs.get(st.roll_no) ?? [];
    if (!devices.length) continue;

    // ---- the bus has set off ------------------------------------------
    // Only worth saying early in the run; a student opening the app at the
    // halfway point does not need to be told it started twenty minutes ago.
    if (trip.progress < 0.12 && await claim(tripId, st.roll_no, 'started')) {
      for (const d of devices) {
        await deliver(d, {
          kind: 'started',
          title: home ? `${routeName} has left the college` : `${routeName} has started`,
          body: mine ? `Heading for ${mine.name}.` : 'Your bus is on the way.',
          tag: `trip-${tripId}-started`,
          url: '/track',
        });
      }
    }

    // ---- nearly at your stop -------------------------------------------
    if (!mine || mine.passed || mine.etaS == null) continue;

    // Each device carries its own warning time, because the student set it:
    // five minutes is a walk down the lane, fifteen is a cycle ride.
    for (const d of devices) {
      const lead = Math.max(1, Math.min(30, d.lead_min));
      const mins = mine.etaS / 60;
      // A window, not a threshold. Below the floor the bus is effectively
      // there and the message would arrive as it pulls away.
      if (mins > lead || mins < lead - 4) continue;
      if (!await claim(tripId, st.roll_no, 'approaching')) break;

      await deliver(d, {
        kind: 'approaching',
        title: `Bus ${Math.max(1, Math.round(mins))} min away`,
        body: `Leave now for ${mine.name}.`,
        tag: `trip-${tripId}-approaching`,
        url: '/track',
        requireInteraction: false,
      });
      break;   // one per student, whichever device got there first
    }
  }

  // ---- reached the college -------------------------------------------
  // Outbound only. Nobody needs telling that the bus home arrived at the
  // village they are standing in.
  const last = view.stops[view.stops.length - 1];
  if (!home && last?.arrivedAt) {
    for (const st of students) {
      if (!await claim(tripId, st.roll_no, 'arrived')) continue;
      for (const d of subs.get(st.roll_no) ?? []) {
        await deliver(d, {
          kind: 'arrived',
          title: 'Bus reached the college',
          body: new Date(last.arrivedAt).toLocaleTimeString('en-IN',
            { hour: '2-digit', minute: '2-digit', hour12: false }),
          tag: `trip-${tripId}-arrived`,
          url: '/',
        });
      }
    }
  }
}

export const pushConfigured = () => configure();
