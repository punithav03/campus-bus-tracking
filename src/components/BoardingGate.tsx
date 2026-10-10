'use client';

import { useCallback, useEffect, useState } from 'react';
import { BoardingPicker } from './BoardingPicker';
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
    if (phase !== 'in' || user?.role !== 'student') { setNeeds(false); return; }
    try {
      const j = await (await fetch('/api/me/transport', { cache: 'no-store' })).json();
      setNeeds(!j?.boarding?.id);
    } catch {
      // Offline. Do not block the app behind a question we cannot save the
      // answer to — let them through and ask next time.
      setNeeds(false);
    }
  }, [phase, user]);

  useEffect(() => { void check(); }, [check]);

  if (needs === null) {
    return (
      <div className="shell" style={{ maxWidth: 560 }}>
        <div className="ti-skeleton" aria-hidden style={{ marginTop: 64 }}>
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
