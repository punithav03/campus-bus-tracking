'use client';

import { useEffect } from 'react';

/**
 * Registers the offline shell. Without this the recorder cannot open on a bus
 * with no signal — which is exactly where it needs to work.
 */
export function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return; // http:// on a LAN address — not allowed
    const t = setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* offline support is a bonus, never a hard requirement */
      });
    }, 1200);
    return () => clearTimeout(t);
  }, []);
  return null;
}
