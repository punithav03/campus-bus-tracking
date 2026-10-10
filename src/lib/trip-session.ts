'use client';

import { startTracking, isNativeApp, type Tracker } from './tracker';
import type { Ping } from './types';
import { apiFetch } from './api';

/**
 * The trip, living OUTSIDE React.
 *
 * This used to be state inside the Drive page, and that was a real fault: a
 * React page is destroyed the moment you navigate away, so the driver tapping
 * "Track" to glance at his own bus tore down the GPS watcher and the flush
 * timer, and the trip quietly died. He had done nothing wrong and got no
 * warning — the bus simply stopped moving for every student watching.
 *
 * A trip is not a property of a screen. It belongs to the phone, and it ends
 * for exactly two reasons: the driver stops it, or the bus reaches the college.
 * So it lives here, in the module, and the page merely subscribes to it. Change
 * screens, come back, the trip is still running.
 */

const FLUSH_MS = 10000;
/** Survives the app being closed, so a reopened app can pick the trip back up. */
const ACTIVE_KEY = 'campusbus.activeTrip';
/** Ask the server whether the run is over. Cheap, and only while tracking. */
const CHECK_EVERY = 3;

export interface TripState {
  running: boolean;
  routeId: string;
  captured: number;
  accepted: number;
  buffered: number;
  lastAcc: number | null;
  nextStop: string | null;
  distKm: number | null;
  /** True when GPS keeps running with the screen off. */
  background: boolean;
  message: string | null;
  /** Set when the bus reached the college and the trip closed itself. */
  arrived: boolean;
  /** True when this trip was picked back up after the app was closed. */
  resumed: boolean;
}

const idle: TripState = {
  running: false, routeId: '', captured: 0, accepted: 0, buffered: 0,
  lastAcc: null, nextStop: null, distKm: null,
  background: false, message: null, arrived: false, resumed: false,
};

let state: TripState = { ...idle };
let tracker: Tracker | null = null;
let queue: Ping[] = [];
let flusher: ReturnType<typeof setInterval> | null = null;
let wakeLock: { release: () => Promise<void> } | null = null;
let ticks = 0;

const listeners = new Set<(s: TripState) => void>();

function set(patch: Partial<TripState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function getTripState(): TripState { return state; }

const remember = (routeId: string | null) => {
  try {
    if (routeId) localStorage.setItem(ACTIVE_KEY, routeId);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* private mode — resume simply will not be offered */ }
};

/**
 * Picks a trip back up after the app was closed.
 *
 * Swiping the app away from recents kills the process, and with it the GPS
 * watcher and this module — Android gives nothing a way around that. What it
 * must NOT also do is quietly leave the bus dark: the driver reopens the app,
 * sees a Start button, and has no idea he has been off the air since the last
 * roundabout.
 *
 * The server still knows the trip is running, so on open we ask, and if it is,
 * we start broadcasting again without making him do anything. He is driving.
 */
export async function resumeTripIfRunning(): Promise<void> {
  if (state.running) return;
  let routeId: string | null = null;
  try { routeId = localStorage.getItem(ACTIVE_KEY); } catch { return; }
  if (!routeId) return;

  try {
    const r = await fetch(`/api/state?route=${routeId}`, { cache: 'no-store' });
    const j = await r.json();
    if (j?.trip?.status !== 'running') { remember(null); return; }
  } catch {
    return;   // offline: leave it alone rather than guess
  }

  await startTrip(routeId, { resumed: true });
}

export function subscribeTrip(fn: (s: TripState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ---------------------------------------------------------------------------

async function flush() {
  if (!queue.length || !state.routeId) return;
  const batch = queue;
  queue = [];
  set({ buffered: 0 });
  try {
    const r = await apiFetch('/api/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId: state.routeId, pings: batch, source: 'driver' }),
    });
    const j = await r.json();
    set({
      accepted: state.accepted + (j.accepted ?? 0),
      nextStop: j.nextStop ?? null,
      distKm: j.distAlongM != null ? j.distAlongM / 1000 : null,
    });
  } catch {
    // A dead zone is not a failure. Put them back at the FRONT so order holds,
    // and try again next tick — the phone keeps recording either way.
    queue = [...batch, ...queue];
    set({ buffered: queue.length });
  }
}

/**
 * Has the bus reached the college?
 *
 * The engine already knows — it closes the trip once the last stop is served.
 * The driver's phone should not have to be told twice, and expecting him to
 * remember to press stop at the end of a run he has just finished driving is
 * how a phone ends up broadcasting from the staff car park all afternoon.
 */
async function checkArrived() {
  try {
    const r = await fetch(`/api/state?route=${state.routeId}`, { cache: 'no-store' });
    const j = await r.json();
    if (j?.trip?.status === 'finished') {
      await endTrip({ arrived: true });
    }
  } catch { /* offline — ask again next time */ }
}

// ---------------------------------------------------------------------------

export async function startTrip(
  routeId: string,
  opts: { resumed?: boolean } = {},
): Promise<void> {
  if (state.running) return;
  queue = [];
  ticks = 0;
  set({ ...idle, running: true, routeId, resumed: !!opts.resumed });
  remember(routeId);

  // A resumed trip is already open on the server; starting it again would
  // throw away everything it has learned about this run so far.
  if (!opts.resumed) {
    await apiFetch('/api/trip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId, action: 'start' }),
    });
  }

  // Only in a browser. In the app the foreground service does not need the
  // screen, so holding it awake would flatten the battery for nothing.
  if (!isNativeApp()) {
    try {
      const nav = navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    } catch { /* the driver can raise the screen timeout instead */ }
  }

  tracker = await startTracking(
    (fix) => {
      queue.push({
        lat: fix.lat, lng: fix.lng, spd: fix.spd,
        acc: fix.acc, heading: fix.heading, t: fix.t,
      });
      set({
        captured: state.captured + 1,
        buffered: queue.length,
        lastAcc: fix.acc,
      });
    },
    (message) => set({ message }),
  );
  set({ background: tracker.kind === 'native' });

  flusher = setInterval(() => {
    void flush();
    if (++ticks % CHECK_EVERY === 0) void checkArrived();
  }, FLUSH_MS);
}

export async function endTrip(opts: { arrived?: boolean } = {}): Promise<unknown | null> {
  if (!state.running) return null;
  const routeId = state.routeId;
  let summary: unknown = null;

  await tracker?.stop();
  tracker = null;
  if (flusher) clearInterval(flusher);
  flusher = null;

  await flush();                       // never lose the last few seconds

  try {
    const r = await apiFetch('/api/trip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId, action: 'end' }),
    });
    // The server knows what the run actually looked like — stops served,
    // how long, how early. Worth showing him; he just drove it.
    summary = (await r.json())?.summary ?? null;
  } catch { /* the engine closes it on its own once the pings stop */ }

  try { await wakeLock?.release(); } catch { /* already gone */ }
  wakeLock = null;

  remember(null);
  set({
    running: false,
    resumed: false,
    arrived: !!opts.arrived,
    message: opts.arrived ? 'Reached the college — trip ended automatically.' : null,
  });
  return summary;
}
