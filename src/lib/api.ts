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

// ---------------------------------------------------------------------------

export interface PostResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  /** 'native' when it went out over the Android HTTP stack. */
  via: 'native' | 'web';
}

/**
 * POST some JSON, and get it off the phone even when the app is in the pocket.
 *
 * THIS IS WHY THE BUS WENT OFFLINE.
 *
 * Android throttles HTTP requests that a backgrounded WebView starts. After
 * about five minutes our flush() was still being called on time, still had a
 * queue of perfectly good fixes, and the POST simply never arrived. Nothing
 * threw. The driver's screen showed fixes piling up and no error, while the
 * server heard nothing and decayed the bus to 'stale'. That is the whole
 * "sometimes it stays live, then it goes offline" symptom: the marker coasted
 * on dead reckoning and then gave up.
 *
 * The plugin's README names the fix — route the request through the native
 * HTTP stack instead, where the throttle does not apply.
 *
 * The session cookie still comes along. Capacitor installs its own
 * CookieHandler as the JVM default (CapacitorCookies.load()) and that handler
 * is backed by android.webkit.CookieManager — the WebView's own jar. httpOnly
 * hides a cookie from JavaScript, not from the native cookie store, so the
 * native request is authenticated exactly like the web one. Our cookie also
 * carries an explicit `expires`, so it is persistent rather than a session
 * cookie and survives the removeSessionCookies() that runs on app start.
 *
 * Falls back to fetch() on anything unexpected. A tracking path must degrade,
 * never fail: a browser has no native stack, and a plugin that has gone
 * missing is not a reason to stop broadcasting the bus.
 */
export async function postJSON(url: string, body: unknown): Promise<PostResult> {
  const native = await postNative(url, body);
  if (native) return native;

  const r = await apiFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    ok: r.ok,
    status: r.status,
    body: await r.json().catch(() => ({})),
    via: 'web',
  };
}

/** Returns null when the native path is unavailable, so the caller can fall back. */
async function postNative(url: string, body: unknown): Promise<PostResult | null> {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  try { if (!cap?.isNativePlatform?.()) return null; } catch { return null; }

  try {
    const { CapacitorHttp } = await import('@capacitor/core');
    // The native stack has no notion of "same origin", so relative paths have
    // to be resolved against the site the WebView is showing.
    const res = await CapacitorHttp.post({
      url: new URL(url, window.location.origin).toString(),
      headers: { 'content-type': 'application/json' },
      data: body,
    });
    // It parses JSON responses for us, but a proxy or an error page may hand
    // back a string. Either way the caller only ever reads known fields.
    const parsed: unknown = typeof res.data === 'string'
      ? JSON.parse(res.data || '{}')
      : res.data;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>,
      via: 'native',
    };
  } catch {
    return null;   // let the web path try
  }
}

// ---------------------------------------------------------------------------

export type GetResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number };

/**
 * GET some JSON, and keep trying for a while before giving up.
 *
 * The free server sleeps, and the first requests after it wakes can be slow
 * or come back as an error page. A screen that took that first failure as
 * the answer stayed blank — the boarding picker showed no stops and nothing
 * to tap, and the student had to close the app several times to get past it.
 * So: a timeout per try, a few tries with a growing pause, and only then a
 * failure the screen has to show. Sign-in problems (401/403) are answers,
 * not hiccups, and come back at once.
 */
export async function getJSON<T>(url: string, tries = 4, timeoutMs = 12_000): Promise<GetResult<T>> {
  let status = 0;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      status = r.status;
      if (r.status === 401 || r.status === 403) return { ok: false, status };
      if (r.ok) return { ok: true, data: (await r.json()) as T };
    } catch {
      status = 0;   // offline, timed out, or not JSON — try again
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status };
}
