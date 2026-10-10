/**
 * Offline shell.
 *
 * The recorder has to open on a moving bus in a village with no signal, so the
 * app itself must survive without the network. But "survive without" and
 * "prefer the cache" are different strategies, and which one is right depends
 * entirely on what is being fetched:
 *
 *  · PAGES are network-first with a short timeout. Serving a cached page is
 *    what makes a stale launch possible: the HTML of an old build names JS
 *    chunks by content hash, and after a deploy those files are gone from the
 *    server. The page then loads, fails to fetch its own scripts, never
 *    hydrates, and sits there — an installed app stuck on its launch screen
 *    with no way for the user to know why. Going to the network first means a
 *    launch gets the current build whenever there is any usable connection,
 *    and the timeout means a dead or sleeping server still opens instantly
 *    from cache instead of hanging.
 *
 *  · STATIC ASSETS are cache-first, and safely so, because /_next/static paths
 *    are content-hashed: a given URL's contents can never change, so a cache
 *    hit is always correct and always instant.
 *
 *  · /api is never cached. A stale bus position is worse than none.
 */

const CACHE = 'campusbus-v6';
const PAGE_TIMEOUT_MS = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/record'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

/** Ours, or the host's interstitial wearing our domain? See next.config.mjs. */
const isOurs = (res) => res.headers.get('x-campus-bus') === 'app';

const put = (request, res) => {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
  }
  return res;
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data must never come from a cache.
  if (url.pathname.startsWith('/api/')) return;

  // Nor may the App Router's own navigation payloads. Clicking a tab does not
  // fetch a page — it fetches an RSC payload from the SAME url as the page,
  // distinguished only by a header. The Cache API keys on the url, so caching
  // these risks handing React a document where it expected a payload, and the
  // navigation fails while a reload (a real document request) works fine.
  // Always go to the network for them.
  if (request.headers.get('RSC') === '1'
      || request.headers.get('Next-Router-Prefetch') === '1'
      || url.searchParams.has('_rsc')) return;

  // ---- pages: network-first, fall back fast -------------------------------
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await Promise.race([
          fetch(request).then((r) => (isOurs(r) ? put(request, r) : r)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), PAGE_TIMEOUT_MS)),
        ]);
        // A holding page from the host is not the app. Prefer the real thing
        // we already have on the device over an interstitial that will not
        // become one until the server finishes waking.
        if (!isOurs(res)) {
          const cached = await caches.match(request) ?? await caches.match('/');
          if (cached) return cached;
        }
        return res;
      } catch {
        // Offline, or a host that is still waking up. Either way, open now.
        return (await caches.match(request))
            ?? (await caches.match('/'))
            ?? Response.error();
      }
    })());
    return;
  }

  // ---- everything else: cache-first, refreshed behind you -----------------
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((r) => put(request, r)).catch(() => hit);
      return hit || network;
    }),
  );
});


/* ==========================================================================
   PUSH
   The only part of this app that reaches a student who is not looking at it.
   ========================================================================== */

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* keep the default */ }

  const title = d.title || 'SVPCET Bus';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // A tag replaces rather than stacks. Three "bus is coming" notifications
    // from three ticks would be the fastest way to get push switched off for
    // good by the person who most needed it.
    tag: d.tag || 'svpcet-bus',
    renotify: true,
    // Vibration is the point: the phone is in a pocket at a bus stop and
    // nobody is watching the screen.
    vibrate: [90, 50, 90],
    data: { url: d.url || '/', kind: d.kind || 'info' },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  // Reuse a tab that is already open rather than piling up new ones — the
  // student taps this every morning.
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

/**
 * Chrome occasionally retires a subscription and hands out a new one. Without
 * this the student stops being told and never finds out why — the UI would
 * still happily say notifications are on.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.subscribe(
        event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true },
      );
      await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    } catch { /* the app re-subscribes next time it is opened */ }
  })());
});
