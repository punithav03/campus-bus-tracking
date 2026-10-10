'use client';

import { useEffect, useState } from 'react';
import { haptic } from '@/lib/device';

/**
 * "I'm at the stop."
 *
 * This exists because of a failure GPS cannot see: the driver glances at a
 * stop, sees nobody standing in the obvious place, and keeps going — while
 * three students wait under the shelter twenty metres back. One tap puts a
 * count on his screen.
 *
 * It expires on its own after 45 minutes. A student who taps it and then gets
 * a lift home should not leave a ghost standing at Pudi Gate all afternoon,
 * and asking them to remember to cancel is asking for a feature nobody can
 * trust.
 */
export function WaitingButton({ stopName }: { stopName: string | null }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch('/api/me/waiting', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setOn(!!j.waiting))
      .catch(() => setOn(false));
  }, []);

  if (on === null || !stopName) return null;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !on;
    setOn(next);                       // optimistic: the tap must feel instant
    haptic(next ? 'select' : 'tick');
    try {
      const r = await fetch('/api/me/waiting', { method: next ? 'POST' : 'DELETE' });
      if (!r.ok) setOn(!next);
    } catch {
      setOn(!next);
    }
    setBusy(false);
  }

  return (
    <button className="wt" data-on={on} onClick={toggle} disabled={busy}>
      <span className="wt-ic" aria-hidden>
        {on ? (
          <svg viewBox="0 0 24 24" width="18" height="18">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="m8 12.4 2.6 2.6L16 9.6" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18">
            <circle cx="12" cy="7" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5.6 20.4a6.4 6.4 0 0 1 12.8 0" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <span className="wt-text">
        <span className="wt-title">
          {on ? `Waiting at ${stopName}` : `I'm at ${stopName}`}
        </span>
        <span className="wt-sub">
          {on ? 'The driver can see you. Tap to cancel.' : 'Let the driver know not to pass you.'}
        </span>
      </span>
    </button>
  );
}
