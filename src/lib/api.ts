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
