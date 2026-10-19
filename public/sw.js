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

const CACHE = 'campusbus-v9';
// The basemap lives in its own cache: 12 MB that must survive app updates,
// replaced only when a new map file (a new name) ships.
const MAP_CACHE = 'campusbus-map';
const PAGE_TIMEOUT_MS = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/record'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== MAP_CACHE).map((k) => caches.delete(k))),
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

  // The map file is read in small byte ranges, one per tile. Served from a
  // full copy kept on the phone, the map works with no signal at all.
  if (url.pathname.startsWith('/maps/') && url.pathname.endsWith('.pmtiles')) {
    event.respondWith(mapRange(event, request, url.pathname));
    return;
  }

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
   OFFLINE MAP
   ========================================================================== */

/** The whole map file, once read from the cache, so each tile is a cheap slice. */
let mapBlob = null;
let mapBlobPath = null;
let mapFetching = null;

async function mapRange(event, request, path) {
  const cache = await caches.open(MAP_CACHE);
  if (mapBlobPath !== path) {
    const hit = await cache.match(path);
    mapBlob = hit ? await hit.blob() : null;
    mapBlobPath = hit ? path : null;
  }
  if (!mapBlob) {
    // First visit: answer from the network now, and fetch the whole file once
    // in the background for next time. Older map files are dropped then.
    if (!mapFetching) {
      mapFetching = fetch(path).then(async (r) => {
        if (r.status !== 200) return;
        await cache.put(path, r.clone());
        for (const k of await cache.keys()) if (new URL(k.url).pathname !== path) await cache.delete(k);
      }).catch(() => {}).finally(() => { mapFetching = null; });
      event.waitUntil(mapFetching);
    }
    return fetch(request);
  }
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get('Range') || '');
  if (!range) return new Response(mapBlob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  const size = mapBlob.size;
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(mapBlob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}


/* ==========================================================================
   PUSH
   The only part of this app that reaches a student who is not looking at it.
   ========================================================================== */

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* keep the default */ }

  const title = d.title || 'SVPCET Bus';
  const alert = d.alert !== false;
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // The route picture: Chrome on Android shows it when the card is expanded.
    image: d.image ? new URL(d.image, self.location.origin).href : undefined,
    // ONE card per trip. A new message with the same tag replaces the card
    // rather than stacking another under it — the way a ride-hailing app keeps
    // a single "your driver is 4 min away" card current.
    tag: d.tag || 'svpcet-bus',
    // Alerts buzz; updates change the card quietly. Buzzing on every minute
    // tick is the fastest way to get notifications switched off for good.
    renotify: alert,
    silent: !alert,
    vibrate: alert ? [120, 60, 120] : undefined,
    timestamp: d.timestamp || Date.now(),
    actions: Array.isArray(d.actions) ? d.actions.slice(0, 2) : [],
    data: { url: d.url || '/', kind: d.kind || 'info' },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const url = (n.data && n.data.url) || '/';

  if (event.action === 'dismiss') { n.close(); return; }

  // "I'm at the stop", straight from the notification: tell the driver
  // without opening anything, then confirm on the same card.
  if (event.action === 'waiting') {
    event.waitUntil((async () => {
      let ok = false;
      try {
        const r = await fetch('/api/me/waiting', { method: 'POST', credentials: 'include' });
        ok = r.ok;
      } catch { /* offline */ }
      await self.registration.showNotification(ok ? 'Driver told you are waiting' : 'Could not reach the server', {
        body: ok ? 'Your stop will show as waiting on the driver\'s screen.' : 'Open the app and tap "I\'m at the stop".',
        icon: '/icon-192.png', badge: '/icon-192.png',
        tag: n.tag, silent: true, renotify: false,
        actions: [{ action: 'track', title: 'Track live' }],
        data: n.data,
      });
    })());
    return;
  }

  n.close();
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
