'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Turning notifications on, from the browser's side.
 *
 * The permission prompt is the one thing in this app we only ever get to ask
 * once. A browser that is denied will not ask again, and the student has no
 * obvious way back — so it is never triggered on load, only from a button the
 * student deliberately pressed, having read what it is for.
 */

export type PushState =
  | 'unsupported'    // the browser cannot do this at all
  | 'unavailable'    // the server has no keys configured
  | 'blocked'        // the student said no, and the browser will not re-ask
  | 'off'
  | 'on'
  | 'working';

const urlB64ToUint8 = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

export function usePush() {
  const [state, setState] = useState<PushState>('working');
  const [leadMin, setLeadMin] = useState(5);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState('unsupported');
      return;
    }
    try {
      const info = await (await fetch('/api/push', { cache: 'no-store' })).json();
      if (!info.available || !info.publicKey) { setState('unavailable'); return; }
      setLeadMin(info.leadMin ?? 5);

      if (Notification.permission === 'denied') { setState('blocked'); return; }

      // The browser's own record is the truth, not ours: a student who
      // cleared site data still has a row in our table and no subscription.
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    } catch {
      setState('unavailable');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const enable = useCallback(async (lead = leadMin) => {
    setError(null);
    setState('working');
    try {
      const info = await (await fetch('/api/push', { cache: 'no-store' })).json();
      if (!info.publicKey) throw new Error('Notifications are not set up on the server.');

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return false;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription()
        ?? await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(info.publicKey),
        });

      const r = await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...sub.toJSON(), leadMin: lead }),
      });
      if (!r.ok) throw new Error('Could not save on the server.');

      setLeadMin(lead);
      setState('on');
      return true;
    } catch (e) {
      setError((e as Error).message);
      await refresh();
      return false;
    }
  }, [leadMin, refresh]);

  const disable = useCallback(async () => {
    setState('working');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      // Unsubscribe in the browser AND delete on the server. Doing only the
      // first leaves us pushing into a void; only the second leaves the
      // browser quietly delivering notifications nothing will ever send.
      await fetch('/api/push', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub?.endpoint ?? null }),
      });
      await sub?.unsubscribe();
    } catch { /* best effort */ }
    setState('off');
  }, []);

  const setLead = useCallback(async (mins: number) => {
    setLeadMin(mins);
    if (state === 'on') await enable(mins);
  }, [state, enable]);

  return { state, leadMin, error, enable, disable, setLead, refresh };
}
