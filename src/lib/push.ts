import webpush from 'web-push';
import { sql } from './db';
import type { StateView } from './types';
import type { Direction } from './trip-store';
import { cardFor, type Alert } from './push-plan';

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
 *   NEVER NOISY. Four kinds, total: it started, it is nearly at your stop,
 *   it went on WITHOUT coming to your stop, it reached the college. Nothing
 *   else earns an interruption — and the skipped one earns it most, because
 *   it is the only one that tells a student to stop waiting.
 */

let configured = false;
/** Why push is not working, in words safe to show — never the keys themselves. */
let problem: string | null = null;

/**
 * Keys pasted into a hosting dashboard pick up quotes, spaces and line breaks.
 * web-push rejects them by throwing, which used to turn GET /api/push into a
 * bare 500 and hid the notifications card for every student. Clean them up,
 * and if they are still wrong, say which one.
 */
const clean = (v: string | undefined) => (v ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, '');
export const vapidPublicKey = () => clean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) || null;

function configure(): boolean {
  if (configured) return true;
  const pub = clean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const priv = clean(process.env.VAPID_PRIVATE_KEY);
  let subject = (process.env.VAPID_SUBJECT ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!/^(mailto:|https:)/.test(subject)) subject = subject.includes('@') ? `mailto:${subject}` : 'mailto:transport@svpcet.ac.in';
  if (!pub || !priv) { problem = 'The server has no notification keys (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).'; return false; }
  try {
    webpush.setVapidDetails(subject, pub, priv);
  } catch (e) {
    problem = `The server's notification keys are not valid: ${(e as Error).message}`;
    console.error('[push]', problem);
    return false;
  }
  configured = true;
  problem = null;
  return true;
}

export const pushProblem = () => problem;

export type Kind = Alert;

interface Sub {
  endpoint: string; p256dh: string; auth: string;
  roll_no: string; lead_min: number;
}

/** What goes to the service worker, which turns it into the notification. */
export interface PushPayload {
  title: string;
  body: string;
  /** One card per trip: the same tag replaces the old card instead of stacking. */
  tag: string;
  url: string;
  image?: string | null;
  /** Buzz (an alert) or change the card quietly (an update). */
  alert: boolean;
  kind: string;
  actions?: { action: string; title: string }[];
  timestamp: number;
}

/**
 * Dry run: write what would be sent to data/push-dry-run.jsonl instead of
 * sending. For testing the whole flow with a demo replay and no phone.
 */
const DRY = process.env.PUSH_DRY_RUN === '1';

/**
 * Sends one payload to one device.
 *
 * Alerts go out at high urgency, so a phone in battery saver still wakes for
 * "leave now". Updates are normal urgency and carry a topic: if the phone is
 * offline, the push service keeps only the newest update rather than
 * delivering five stale ones when it reconnects.
 *
 * A 404 or 410 means the browser threw the subscription away — the student
 * cleared site data, or uninstalled. Those are not errors to retry; they are
 * rows to delete, and keeping them would mean pushing to the dead forever.
 */
async function deliver(sub: Sub, payload: PushPayload): Promise<boolean> {
  if (DRY) {
    const { appendFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    appendFileSync(join(process.cwd(), 'data', 'push-dry-run.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), roll: sub.roll_no, ...payload })}\n`);
    return true;
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        TTL: payload.alert ? 300 : 120,   // useless once stale; do not let it linger
        urgency: payload.alert ? 'high' : 'normal',
        // At most 32 URL-safe characters; one per card.
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
      },
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
 * Claims the right to send an alert. Returns false if somebody already did.
 *
 * The insert IS the lock. Checking first and sending second would let two
 * ticks overlapping by a millisecond both decide they were first, and the
 * student gets told twice. It also survives a restart, which the in-memory
 * card state below does not.
 */
async function claim(tripId: number, roll: string, kind: string): Promise<boolean> {
  const rows = await sql(
    `INSERT INTO notifications_sent (trip_id, roll_no, kind) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING roll_no`,
    [tripId, roll, kind],
  );
  return rows.length > 0;
}

async function alreadySent(tripId: number, roll: string): Promise<Set<Alert>> {
  const rows = await sql<{ kind: string }>(
    'SELECT kind FROM notifications_sent WHERE trip_id = $1 AND roll_no = $2', [tripId, roll]);
  return new Set(rows.map((r) => (r.kind === 'approaching' ? 'leave' : r.kind) as Alert));
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
 * The live card's last state per student, so a quiet update is only sent when
 * something a student would notice has changed — the minutes, the stops away —
 * and never more than about once every 45 seconds. In memory: after a restart
 * the worst case is one extra quiet update.
 */
interface CardState { sent: Set<Alert>; etaMin: number | null; stopsAway: number | null; at: number; title: string; done: boolean; dismissed: boolean }
const cards = new Map<string, CardState>();
const UPDATE_MIN_GAP_MS = 45_000;
const UPDATE_MAX_GAP_MS = 150_000;

/**
 * Works through one running trip and keeps every subscribed student's card
 * up to date. Called from the live ticker every fifteen seconds.
 */
export async function notifyForTrip(
  tripId: number,
  routeId: string,
  direction: Direction,
  view: StateView,
): Promise<void> {
  if (!DRY && !configure()) return;
  if (!view.trip) return;
  void direction;

  // Everyone on this bus who has asked to be told.
  const students = await sql<{ roll_no: string; stop_id: string | null }>(
    `SELECT s.roll_no, s.stop_id
       FROM students s
      WHERE s.route_id = $1
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.roll_no = s.roll_no)`,
    [routeId],
  );
  if (!students.length) return;
  const subs = await subsFor(students.map((s) => s.roll_no));
  const now = Date.now();

  for (const st of students) {
    const devices = subs.get(st.roll_no) ?? [];
    if (!devices.length) continue;
    const key = `${tripId}:${st.roll_no}`;
    let state = cards.get(key);
    if (!state) {
      const before = await alreadySent(tripId, st.roll_no);
      state = { sent: before, etaMin: null, stopsAway: null, at: 0, title: '', done: false,
        dismissed: (before as Set<string>).has('dismissed') };
      cards.set(key, state);
    }
    if (state.done) continue;

    // The earliest warning any of their devices asked for.
    const lead = Math.max(1, Math.min(30, Math.max(...devices.map((d) => d.lead_min))));
    const card = cardFor({ view, stopId: st.stop_id, leadMin: lead, sent: state.sent, now, dismissed: state.dismissed });
    if (!card) continue;

    let alert = card.alert;
    if (alert && !await claim(tripId, st.roll_no, alert)) {
      state.sent.add(alert);
      alert = null;     // already sent (another tick, or before a restart): quiet update
    }

    const changed = card.etaMin !== state.etaMin || card.stopsAway !== state.stopsAway;
    const gap = now - state.at;
    const update = !alert && !state.dismissed && card.phase === 'live' &&
      ((changed && gap >= UPDATE_MIN_GAP_MS) || gap >= UPDATE_MAX_GAP_MS);
    // A closing card ("left your stop at 08:20") replaces the live one, once.
    const final = !alert && !state.dismissed && card.phase === 'done' && state.at > 0 && card.title !== state.title;
    if (!alert && !update && !final) continue;

    const payload: PushPayload = {
      title: card.title,
      body: card.body,
      tag: `bus-${tripId}`,
      url: '/track',
      image: card.image,
      alert: !!alert,
      kind: alert ?? (card.phase === 'done' ? 'final' : 'update'),
      actions: card.canWait
        ? [{ action: 'track', title: 'Track live' }, { action: 'waiting', title: "I'm at the stop" }]
        : [{ action: 'track', title: 'Open' }],
      timestamp: now,
    };
    for (const d of devices) await deliver(d, payload);

    if (alert) state.sent.add(alert);
    state.etaMin = card.etaMin;
    state.stopsAway = card.stopsAway;
    state.at = now;
    state.title = card.title;
    // Nothing more to say after the college arrival or a skip. After "left
    // your stop" the card stays open for the college arrival.
    if (alert === 'arrived' || alert === 'skipped') state.done = true;
  }

  if (cards.size > 5000) {
    for (const [k, v] of cards) if (now - v.at > 6 * 3600_000) cards.delete(k);
  }
}

/**
 * The student swiped this trip's card away. Remembered in the database (so a
 * restart keeps it) and in the live card state (so the very next tick obeys).
 */
export async function markDismissed(tripId: number, roll: string): Promise<void> {
  await claim(tripId, roll, 'dismissed');
  const state = cards.get(`${tripId}:${roll}`);
  if (state) state.dismissed = true;
}

/**
 * A sample card on every device of one student — "Send a test" in the app.
 * Proves the whole chain (permission, subscription, push service, service
 * worker) end to end, so nobody finds out on the morning it matters.
 */
export async function sendTest(roll: string, routeName: string, stopName: string | null): Promise<number> {
  if (!DRY && !configure()) return 0;
  const devices = (await subsFor([roll])).get(roll) ?? [];
  const q = new URLSearchParams({
    c: 'f97316', p: '420', s: '0.150.300.420.560.700.850.1000', m: '700',
    n: stopName ?? 'Your stop', e: '6', st: 'live', r: routeName,
  });
  let ok = 0;
  for (const d of devices) {
    const sent = await deliver(d, {
      title: `${routeName} · 6 min to ${stopName ?? 'your stop'}`,
      body: 'This is a test. On the day this card updates by itself as the bus comes, and buzzes when it is time to leave.',
      tag: 'bus-test',
      url: '/track',
      image: `/api/push/card?${q.toString()}`,
      alert: true,
      kind: 'test',
      actions: [{ action: 'track', title: 'Track live' }, { action: 'dismiss', title: 'Got it' }],
      timestamp: Date.now(),
    });
    if (sent) ok++;
  }
  return ok;
}

export const pushConfigured = () => configure();
