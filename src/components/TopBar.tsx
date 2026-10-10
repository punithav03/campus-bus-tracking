'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandLogo } from '@/components/BrandLogo';
import { haptic } from '@/lib/device';
import { useSession } from '@/lib/useSession';
import type { Role } from '@/lib/session';

/**
 * The nav shows what this account can actually reach, and nothing else.
 *
 * It used to hide links behind a shared PIN, which meant every student's phone
 * rendered four tabs and then collapsed to one. Now the role is known before
 * the first paint of a signed-in page, so the bar is correct immediately —
 * a student never sees a Drive tab exists, and a driver is not offered an
 * admin screen he cannot open.
 */
const NAV: { href: string; label: string; roles: Role[] }[] = [
  { href: '/',      label: 'Home',  roles: ['student'] },
  { href: '/track', label: 'Track', roles: ['student', 'driver', 'admin'] },
  { href: '/drive', label: 'Drive', roles: ['driver'] },
  { href: '/admin', label: 'Fleet', roles: ['admin'] },
];

export function TopBar({ subtitle }: { subtitle?: string }) {
  const path = usePathname();
  const { phase, user } = useSession();

  // While we do not yet know who this is, show nothing rather than guess.
  // A bar that flickers from four links to one is worse than a bar that
  // arrives a moment late.
  const items = phase === 'in' && user
    ? NAV.filter((n) => n.roles.includes(user.role))
    : [];

  return (
    <header className="topbar">
      <Link href="/" className="brand" style={{ textDecoration: 'none' }} prefetch={false}>
        <div className="brand-mark">
          <BrandLogo idPrefix="hb" />
        </div>
        <div className="brand-text">
          <div className="brand-title">SVPCET Bus</div>
          <div className="brand-sub">{subtitle ?? 'Puttur · live tracking'}</div>
        </div>
      </Link>

      <div className="topbar-spacer" />

      <nav style={{ display: 'flex', gap: 4 }}>
        {items.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="navlink"
            data-active={path === n.href}
            aria-current={path === n.href ? 'page' : undefined}
            onClick={() => haptic('tick')}
          >
            {n.label}
          </Link>
        ))}
      </nav>

      {/* A gear, not another word. Settings is somewhere people go rarely, and
          giving it equal weight to Track would be a lie about how often it
          matters. Outside <nav> so the scrolling tab strip cannot carry it off
          the edge of a small screen. Sign out lives inside it. */}
      {phase === 'in' && user && (
        <Link
          href="/settings"
          prefetch={false}
          className="navicon"
          data-active={path === '/settings'}
          aria-label="Settings"
          title={`${user.name} · settings`}
          onClick={() => haptic('tick')}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M19.3 14.4a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.17a1.8 1.8 0 1 1-3.6 0v-.09a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06A1.8 1.8 0 1 1 5.66 16.3l.06-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9h-.17a1.8 1.8 0 1 1 0-3.6h.09a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.06-.06A1.8 1.8 0 1 1 8.13 4.85l.06.06a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37v-.17a1.8 1.8 0 1 1 3.6 0v.09a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.17a1.8 1.8 0 1 1 0 3.6h-.09a1.5 1.5 0 0 0-1.37.9z"
              fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </Link>
      )}
    </header>
  );
}
