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
 */
let cached: Auth | null = null;
const listeners = new Set<(a: Auth) => void>();

function publish(a: Auth) {
  cached = a;
  for (const fn of listeners) fn(a);
}

export async function refreshAuth(): Promise<Auth> {
  try {
    const s = await authState();
    // A network failure must NOT open the page. Fail closed: if the server
    // cannot confirm, assume it is protected.
    const next: Auth = s.required
      ? (s.ok ? { phase: 'open', required: true } : { phase: 'locked' })
      : { phase: 'open', required: false };
    publish(next);
    return next;
  } catch {
    publish({ phase: 'error' });
    return { phase: 'error' };
  }
}

export function useAuth(): Auth {
  const [auth, setAuth] = useState<Auth>(cached ?? { phase: 'checking' });

  useEffect(() => {
    listeners.add(setAuth);
    if (!cached) void refreshAuth();
    else setAuth(cached);
    return () => { listeners.delete(setAuth); };
  }, []);

  return auth;
}
