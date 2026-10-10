'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Role } from './session';

/**
 * Who is signed in, on the client.
 *
 * Fetched once and shared, because four components asking the same question on
 * every navigation is four round trips a student pays for on village mobile
 * data. The answer is cached in the module, not in React state, so it survives
 * a page change; only an explicit refresh() or a sign-out clears it.
 */

export interface User {
  id: string;
  name: string;
  role: Role;
  routeId: string | null;
  mustChangePassword: boolean;
}

export type Phase = 'checking' | 'in' | 'out';

let cached: User | null | undefined;          // undefined = not asked yet
let inflight: Promise<User | null> | null = null;
const listeners = new Set<(u: User | null | undefined) => void>();

function broadcast() { for (const fn of listeners) fn(cached); }

async function fetchMe(): Promise<User | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch('/api/auth/me', { cache: 'no-store' });
      const j = await r.json();
      cached = (j?.user ?? null) as User | null;
    } catch {
      // Offline. Treat as unknown rather than signed out — throwing a student
      // back to the login screen because a tunnel ate one request would be
      // worse than showing a stale name.
      cached = cached ?? null;
    }
    inflight = null;
    broadcast();
    return cached ?? null;
  })();
  return inflight;
}

export function useSession(): { phase: Phase; user: User | null; refresh: () => void } {
  const [user, setUser] = useState<User | null | undefined>(cached);

  useEffect(() => {
    const fn = (u: User | null | undefined) => setUser(u);
    listeners.add(fn);
    if (cached === undefined) void fetchMe();
    else setUser(cached);
    return () => { listeners.delete(fn); };
  }, []);

  const refresh = useCallback(() => { cached = undefined; void fetchMe(); }, []);

  return {
    phase: user === undefined ? 'checking' : user ? 'in' : 'out',
    user: user ?? null,
    refresh,
  };
}

export function setSessionUser(u: User | null) { cached = u; broadcast(); }

export async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
  setSessionUser(null);
  window.location.href = '/login';
}

/** Where this role belongs after signing in. */
export function homeFor(role: Role): string {
  return role === 'driver' ? '/drive' : role === 'admin' ? '/admin' : '/';
}
