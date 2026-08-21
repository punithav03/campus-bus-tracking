'use client';

const KEY = 'campusbus.pin';

export const getPin = () => {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
};

export const setPin = (pin: string) => {
  try { localStorage.setItem(KEY, pin); } catch { /* private mode */ }
};

export const clearPin = () => {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
};

/**
 * fetch() with the PIN attached. Every write goes through this — a request that
 * skips it gets a 401 from the server rather than quietly doing nothing.
 */
export function authFetch(url: string, init: RequestInit = {}) {
  const pin = getPin();
  return fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { ...(init.headers ?? {}), ...(pin ? { 'x-campus-pin': pin } : {}) },
  });
}

/** Ask the server whether a PIN is needed at all, and whether ours is right. */
export async function authState(): Promise<{ required: boolean; ok: boolean }> {
  // No try/catch here on purpose. A failure must reach the caller so it can
  // fail CLOSED — swallowing it here is what let a network blip silently open
  // the admin pages.
  const r = await fetch('/api/auth', {
    cache: 'no-store',
    headers: getPin() ? { 'x-campus-pin': getPin() } : {},
  });
  if (!r.ok && r.status !== 401) throw new Error(`auth check failed: ${r.status}`);
  const j = await r.json();
  return { required: !!j.required, ok: !!j.ok };
}
