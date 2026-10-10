'use client';

import { useCallback, useEffect, useState } from 'react';
import { BoardingPicker } from './BoardingPicker';
import { TopBar } from './TopBar';
import { useSession } from '@/lib/useSession';

/**
 * Asks a student for their boarding point once, and never again.
 *
 * It wraps the page rather than being a route of its own, so there is no URL
 * to skip to and no redirect loop to get wrong — the same shape as
 * PasswordGate, for the same reason.
 *
 * Only students: a driver has no boarding point, and the office has no bus.
 */
export function BoardingGate({ children }: { children: React.ReactNode }) {
  const { phase, user } = useSession();
  const [needs, setNeeds] = useState<boolean | null>(null);

  const check = useCallback(async () => {
    if (phase !== 'in' || user?.role !== 'student') {
      setNeeds(false);
      if (phase !== 'checking') document.documentElement.dataset.ready = '1';
      return;
    }
    try {
      const j = await (await fetch('/api/me/transport', { cache: 'no-store' })).json();
      setNeeds(!j?.boarding?.id);
      // The launch screen waits on this, and by here we know what is about to
      // be shown — the picker or the home screen. Leaving it to the page
      // underneath meant two fetches had to finish in sequence before the
      // logo could lift, so it always sat for its full ceiling.
      document.documentElement.dataset.ready = '1';
    } catch {
      // Offline. Do not block the app behind a question we cannot save the
      // answer to — let them through and ask next time.
      setNeeds(false);
      document.documentElement.dataset.ready = '1';
    }
  }, [phase, user]);

  useEffect(() => { void check(); }, [check]);

  if (needs === null) {
    return (
      <div className="shell" style={{ maxWidth: 560 }}>
        {/* The header belongs in the skeleton too. Without it the page had
            no brand mark, so the launch logo had nothing to fly into and sat
            for its full ceiling before giving up — and the header then
            popped in afterwards. */}
        <TopBar />
        <div className="ti-skeleton" aria-hidden>
          <div className="sk sk-hero" />
          <div className="sk sk-row" />
        </div>
      </div>
    );
  }

  if (needs) {
    return (
      <main className="bp-screen">
        <BoardingPicker mode="setup" onSaved={() => setNeeds(false)} />
      </main>
    );
  }

  return <>{children}</>;
}
