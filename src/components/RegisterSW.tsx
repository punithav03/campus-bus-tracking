'use client';

import { useEffect } from 'react';

/**
 * Registers the offline shell and keeps it current.
 *
 * The cache is served first on purpose: the app opens instantly, with no blank
 * frame while the network answers. The cost of that is normally being one
 * version behind — so instead of switching to network-first and reintroducing
 * the lag, updates are checked and applied at the one moment where a reload
 * costs the user nothing: when they come back to the page.
 */
export function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return; // http:// on a LAN address — not allowed

    let reg: ServiceWorkerRegistration | null = null;
    let updateWaiting = false;
    let reloading = false;

    const applyIfReady = () => {
      if (!updateWaiting || reloading) return;
      reloading = true;
      window.location.reload();
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Coming back is the cheapest possible moment to take an update: nothing
      // is half-typed, nothing is mid-gesture.
      applyIfReady();
      // And ask whether a newer version exists, so the next return has it.
      reg?.update().catch(() => { /* offline — try again next time */ });
    };

    const onControllerChange = () => {
      updateWaiting = true;
      // If the page is in the background, swap now and they never see it.
      if (document.visibilityState !== 'visible') applyIfReady();
    };

    const t = setTimeout(async () => {
      try {
        reg = await navigator.serviceWorker.register('/sw.js');
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
        document.addEventListener('visibilitychange', onVisible);
      } catch {
        /* offline support is a bonus, never a hard requirement */
      }
    }, 1200);

    return () => {
      clearTimeout(t);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
