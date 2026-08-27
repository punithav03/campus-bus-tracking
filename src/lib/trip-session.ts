'use client';

import { authFetch } from './client-auth';
import { startTracking, isNativeApp, type Tracker } from './tracker';
import type { Ping } from './types';

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
}

const idle: TripState = {
  running: false, routeId: '', captured: 0, accepted: 0, buffered: 0,
  lastAcc: null, nextStop: null, distKm: null,
  background: false, message: null, arrived: false,
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
    const r = await authFetch('/api/ping', {
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

export async function startTrip(routeId: string): Promise<void> {
  if (state.running) return;
  queue = [];
  ticks = 0;
  set({ ...idle, running: true, routeId });

  await authFetch('/api/trip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routeId, action: 'start' }),
  });

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

export async function endTrip(opts: { arrived?: boolean } = {}): Promise<void> {
  if (!state.running) return;
  const routeId = state.routeId;

  await tracker?.stop();
  tracker = null;
  if (flusher) clearInterval(flusher);
  flusher = null;

  await flush();                       // never lose the last few seconds

  try {
    await authFetch('/api/trip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId, action: 'end' }),
    });
  } catch { /* the engine closes it on its own once the pings stop */ }

  try { await wakeLock?.release(); } catch { /* already gone */ }
  wakeLock = null;

  set({
    running: false,
    arrived: !!opts.arrived,
    message: opts.arrived ? 'Reached the college — trip ended automatically.' : null,
  });
}
