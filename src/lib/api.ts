/**
 * fetch() for anything that changes state.
 *
 * It used to attach a shared PIN header. That is gone: the session now lives
 * in an httpOnly cookie, which the browser sends with every same-origin
 * request on its own. What is left is the part that still matters — never
 * serve a write, or the answer to one, from a cache.
 */
export function apiFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, cache: 'no-store' });
}
