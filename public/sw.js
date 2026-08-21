/**
 * Offline shell.
 *
 * The recorder has to open on a moving bus in a village with no signal, so the
 * app itself must survive without the network. Everything except /api is served
 * cache-first and refreshed in the background; /api is never cached, because a
 * stale bus position is worse than no bus position.
 */

const CACHE = 'campusbus-v2';

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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data must never come from a cache.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);

      // Cache-first so a dead network is instant, with a refresh behind it.
      return hit || network;
    }),
  );
});
