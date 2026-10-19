import type { StateView, StopView } from './types';

/**
 * What one student's notification should say right now — the "live card".
 *
 * Built on what Uber and Swiggy do: ONE notification per trip that keeps
 * itself up to date in place (minutes, stops away, where the bus is, a picture
 * of the route with the bus on it), and only buzzes at the moments that change
 * what the student should do. Android 16 calls these Live Updates; a web app
 * cannot use that native template, but the same card works through web push:
 * the same `tag` replaces the old card instead of stacking a new one, and
 * silent updates change it without a sound.
 *
 * Pure: no database, no network, no clock of its own. push.ts decides when to
 * send what this returns, which keeps every wording and threshold testable.
 */

/** The moments worth a buzz. Everything else is a silent update of the card. */
export type Alert = 'started' | 'leave' | 'arriving' | 'atstop' | 'skipped' | 'arrived';

export interface Card {
  title: string;
  body: string;
  /** Relative URL of the route picture (rendered by /api/push/card). */
  image: string | null;
  /** Set when this card should buzz: once per kind per trip. */
  alert: Alert | null;
  /** 'live' while the bus is coming to you; 'done' once that is settled. */
  phase: 'live' | 'done';
  /** For deciding whether an update is worth sending. */
  etaMin: number | null;
  stopsAway: number | null;
  /** Offer "I'm at the stop" on the card. */
  canWait: boolean;
}

export interface CardInput {
  view: StateView;
  stopId: string | null;
  /** The student's own warning time, minutes. */
  leadMin: number;
  /** Alerts already sent this trip, so a moment is never announced twice. */
  sent: ReadonlySet<Alert>;
  /** Wall clock, for "arrives 08:19". */
  now: number;
}

/** A skipped stop is only announced when the bus went well clear of it. */
export const SKIP_PUSH_MIN_M = 500;

/** "08:19" in India, whatever time zone the server runs in. */
export function clockIST(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
}

const delayText = (s: number) => {
  const m = Math.round(Math.abs(s) / 60);
  if (m < 2) return 'on time';
  return `${m} min ${s > 0 ? 'late' : 'early'}`;
};

const minsText = (m: number) => (m <= 0 ? 'under a minute' : m === 1 ? '1 min' : `${m} min`);

/** Where the bus is, in words a student knows: the last stop it served or passed. */
function nearText(view: StateView): string | null {
  const t = view.trip;
  if (!t) return null;
  let last: StopView | null = null;
  for (const s of view.stops) if (s.state === 'served' && s.distAlongM <= t.distAlongM + 50) last = s;
  const next = view.stops.find((s) => s.seq === t.nextStopSeq) ?? null;
  if (last && next && t.distAlongM - last.distAlongM < 250) return `at ${last.name}`;
  if (next) return last ? `past ${last.name}` : `heading for ${next.name}`;
  return last ? `past ${last.name}` : null;
}

/** The picture: the route as a line of stops, the bus on it, your stop marked. */
function cardImage(view: StateView, mine: StopView | null, etaMin: number | null, state: string): string {
  const len = view.route.lengthM || 1;
  const frac = (d: number) => Math.round((Math.max(0, Math.min(len, d)) / len) * 1000);
  const q = new URLSearchParams({
    c: view.route.color.replace('#', ''),
    p: String(frac(view.trip?.distAlongM ?? 0)),
    s: view.stops.filter((s) => !s.extra).map((s) => frac(s.distAlongM)).join('.'),
    m: mine ? String(frac(mine.distAlongM)) : '',
    n: mine?.name ?? '',
    e: etaMin == null ? '' : String(etaMin),
    st: state,
    r: view.route.short || view.route.name,
  });
  return `/api/push/card?${q.toString()}`;
}

export function cardFor({ view, stopId, leadMin, sent, now }: CardInput): Card | null {
  const trip = view.trip;
  if (!trip) return null;
  const route = view.route.short || view.route.name;
  const mine = stopId ? view.stops.find((s) => s.id === stopId) ?? null : null;
  const last = view.stops[view.stops.length - 1];
  const near = nearText(view);
  const base = { image: null, etaMin: null, stopsAway: null, canWait: false } as const;

  // ---- at the college: the run is over --------------------------------
  if (last?.arrivedAt) {
    return {
      ...base,
      title: `${route} reached ${last.name}`,
      body: `Arrived at ${clockIST(last.arrivedAt)} · ${delayText(last.delayS ?? 0)}.`,
      image: cardImage(view, mine, null, 'arrived'),
      alert: sent.has('arrived') ? null : 'arrived',
      phase: 'done',
    };
  }
  if (trip.status !== 'running') return null;

  // No stop chosen: a plain "on its way" card, no countdown to give.
  if (!mine) {
    return {
      ...base,
      title: `${route} is on its way`,
      body: `${near ? `Now ${near}. ` : ''}Pick your boarding point in the app to get a countdown.`,
      alert: sent.has('started') || trip.progress > 0.15 ? null : 'started',
      phase: 'live',
    };
  }

  // ---- your stop is behind the bus ------------------------------------
  if (mine.state === 'skipped') {
    // Only certain skips are announced: a verified pin, passed well clear.
    // Anything less is shown in the app but never pushed — a notification
    // cannot be taken back.
    const certain = mine.verified !== false && !mine.estimated && (mine.skippedByM ?? 0) >= SKIP_PUSH_MIN_M;
    if (!certain) return null;
    return {
      ...base,
      title: `Bus did not come to ${mine.name}`,
      body: `${route} has gone on along the route without stopping there today${near ? ` (now ${near})` : ''}.`,
      alert: sent.has('skipped') ? null : 'skipped',
      phase: 'done',
    };
  }
  if (mine.state === 'served' || mine.passed) {
    const at = mine.arrivedAt ? clockIST(mine.arrivedAt) : null;
    const stillThere = mine.halted && trip.distAlongM - mine.distAlongM < 120 && trip.speedMps < 2;
    if (stillThere) {
      return {
        ...base,
        title: `${route} is at ${mine.name}`,
        body: `Stopped at your stop${at ? ` since ${at}` : ''}. Board now.`,
        image: cardImage(view, mine, 0, 'atstop'),
        alert: sent.has('atstop') ? null : 'atstop',
        phase: 'live',
        etaMin: 0,
        stopsAway: 0,
      };
    }
    return {
      ...base,
      title: `${route} left ${mine.name}`,
      // "Picked up" only where we know the stop's real spot and saw the bus halt.
      body: `${mine.halted && mine.verified !== false && !mine.estimated ? 'Picked up' : 'Passed'} at ${at ?? 'just now'}. Heading for ${last?.name ?? 'the college'}.`,
      image: cardImage(view, mine, null, 'passed'),
      alert: null,
      phase: 'done',
    };
  }

  // ---- coming to you --------------------------------------------------
  if (mine.etaS == null) return null;
  const etaMin = Math.max(0, Math.round(mine.etaS / 60));
  const stopsAway = view.stops.filter((s) => s.state === 'upcoming' && s.distAlongM <= mine.distAlongM).length;
  const arrives = clockIST(now + mine.etaS * 1000);

  let alert: Alert | null = null;
  if (stopsAway <= 1 && etaMin <= 3 && !sent.has('arriving')) alert = 'arriving';
  // Within the student's warning time: "leave now" — even if the bus has
  // only just started, because that is the thing they need to hear.
  else if (etaMin <= leadMin && !sent.has('leave') && !sent.has('arriving')) alert = 'leave';
  else if (trip.progress < 0.15 && !sent.has('started') && !sent.has('leave') && !sent.has('arriving')) alert = 'started';

  const title = alert === 'arriving' ? `${route} is arriving at ${mine.name}`
    : alert === 'leave' ? `Leave now · bus ${minsText(etaMin)} from ${mine.name}`
    : alert === 'started' ? `${route} has started · ${minsText(etaMin)} to ${mine.name}`
    : `${route} · ${minsText(etaMin)} to ${mine.name}`;

  const parts = [
    stopsAway <= 1 ? 'Next stop is yours' : `${stopsAway} stops away`,
    near ? `now ${near}` : null,
    `arrives ${arrives}`,
    delayText(trip.delayS),
  ].filter(Boolean);

  return {
    title,
    body: parts.join(' · '),
    image: cardImage(view, mine, etaMin, 'live'),
    alert,
    phase: 'live',
    etaMin,
    stopsAway,
    canWait: true,
  };
}
