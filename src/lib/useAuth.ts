'use client';

import { useEffect, useState } from 'react';
import { authState } from './client-auth';

export type Auth =
  | { phase: 'checking' }
  | { phase: 'error' }                       // could not reach the server
  | { phase: 'open'; required: boolean }     // no PIN needed, or ours is correct
  | { phase: 'locked' };

/**
 * One source of truth for "am I allowed to see the private pages", shared by
 * the gate and the nav so they can never disagree — which is what produced a
 * page that sometimes asked for the PIN and sometimes did not.
 *
 * The answer is cached for the tab: re-checking on every navigation made the
 * nav flicker between four links and one.
 *
 * A FAILURE, though, is not an answer, and caching it like one was a bug worth
 * spelling out. A single unlucky check — the free host waking from sleep, a
 * phone switching from Wi-Fi to mobile data — used to poison the cache for the
 * rest of the session. Every tab you opened afterwards read that stale failure
 * and showed "Can't reach the server", and the only way out was a full reload,
 * because reloading is what threw this module away. So: successes are cached,
 * failures are retried, automatically and with backoff, and the moment one
 * succeeds every mounted component hears about it.
 */
let cached: Auth | null = null;
let inFlight: Promise<Auth> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

const listeners = new Set<(a: Auth) => void>();

function publish(a: Auth) {
  cached = a;
  for (const fn of listeners) fn(a);
}

function stopRetrying() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  attempt = 0;
}

function scheduleRetry() {
  if (retryTimer) return;                       // one timer, however many pages
  // 1s, 2s, 4s, 8s, then every 15s. A host waking from sleep takes tens of
  // seconds, and the user should not have to do anything about it.
  const wait = attempt < 4 ? 1000 * 2 ** attempt : 15000;
  attempt++;
  retryTimer = setTimeout(() => { retryTimer = null; void refreshAuth(); }, wait);
}

export async function refreshAuth(): Promise<Auth> {
  // Four pages mounting at once must not become four identical requests.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<Auth> => {
    try {
      const s = await authState();
      stopRetrying();
      // A network failure must NOT open the page. Fail closed: if the server
      // cannot confirm, assume it is protected.
      const next: Auth = s.required
        ? (s.ok ? { phase: 'open', required: true } : { phase: 'locked' })
        : { phase: 'open', required: false };
      publish(next);
      return next;
    } catch {
      publish({ phase: 'error' });
      scheduleRetry();
      return { phase: 'error' };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function useAuth(): Auth {
  const [auth, setAuth] = useState<Auth>(cached ?? { phase: 'checking' });

  useEffect(() => {
    listeners.add(setAuth);

    // Re-check on mount if we have no answer, or only a stale failure.
    if (!cached || cached.phase === 'error') void refreshAuth();
    else setAuth(cached);

    // Coming back to the app, or the network returning, are the two moments
    // most likely to turn a failure into an answer. Both are worth a retry.
    const recheck = () => {
      if (cached?.phase === 'error' && document.visibilityState === 'visible') {
        stopRetrying();
        void refreshAuth();
      }
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('online', recheck);
    window.addEventListener('focus', recheck);

    return () => {
      listeners.delete(setAuth);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('online', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, []);

  return auth;
}
