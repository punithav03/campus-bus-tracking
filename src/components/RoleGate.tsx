'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from './TopBar';
import { useSession, homeFor } from '@/lib/useSession';
import { PasswordGate } from './PasswordGate';
import type { Role } from '@/lib/session';

/**
 * Keeps a page to the people it is for.
 *
 * This is convenience, not security — the API enforces the same rule
 * independently, because a client-side check is a suggestion. What it buys is
 * that nobody is shown a screen they cannot use: a student who types /drive
 * lands back on his own page instead of staring at a Start button that returns
 * 403.
 *
 * While the session is still being fetched it renders a quiet placeholder.
 * Rendering the page and then yanking it away is worse than a short wait.
 */
export function RoleGate({
  allow,
  children,
}: {
  allow: Role[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { phase, user } = useSession();

  useEffect(() => {
    if (phase === 'out') router.replace('/login');
    else if (phase === 'in' && user && !allow.includes(user.role)) {
      router.replace(homeFor(user.role));
    }
  }, [phase, user, allow, router]);

  if (phase !== 'in' || !user || !allow.includes(user.role)) {
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

  // A temporary password gets changed before anything else is reachable.
  return <PasswordGate>{children}</PasswordGate>;
}
