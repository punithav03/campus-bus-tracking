'use client';

import { useEffect } from 'react';

/**
 * Registers the offline shell.
 *
 * It used to RELOAD the page when you came back to it, to apply a waiting
 * update at what looked like a free moment. It was not free. This screen is
 * live: a student who switches to WhatsApp and comes back was reloaded mid
 * journey, losing the tracked position and the framed camera, and the bus
 * reappeared somewhere else. Twice, on a slow return. That is the "come back
 * and the bus has moved somewhere else" fault, and it was self-inflicted.
 *
 * It is also no longer needed. The service worker fetches PAGES network-first
 * now, so an ordinary launch already gets the current version, and a waiting
 * worker takes over at the next launch on its own. Nothing has to be
 * interrupted to stay up to date.
 */
export function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return; // http:// on a LAN address — not allowed

    let reg: ServiceWorkerRegistration | null = null;

    // Ask whether a newer version exists so the NEXT launch has it. Never act
    // on the answer now — the page the student is looking at is live.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      reg?.update().catch(() => { /* offline — try again next time */ });
    };

    const t = setTimeout(async () => {
      try {
        reg = await navigator.serviceWorker.register('/sw.js');
        document.addEventListener('visibilitychange', onVisible);
      } catch {
        /* offline support is a bonus, never a hard requirement */
      }
    }, 1200);

    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
