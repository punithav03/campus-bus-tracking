'use client';

import { BrandLogo } from '@/components/BrandLogo';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { haptic } from '@/lib/device';
import { useAuth } from '@/lib/useAuth';

/**
 * `private` pages control the bus or expose operational data. A student has no
 * use for them, and an advertised /drive link is an invitation to start a fake
 * trip — so they only appear once this device has unlocked.
 */
const NAV = [
  { href: '/', label: 'Track', private: false },
  { href: '/record', label: 'Record', private: true },
  { href: '/drive', label: 'Drive', private: true },
  { href: '/admin', label: 'Admin', private: true },
];

export function TopBar({ subtitle }: { subtitle?: string }) {
  const path = usePathname();
  const auth = useAuth();

  // Show the private links only once we positively know they are reachable:
  // either no PIN is configured, or this device has already unlocked. While the
  // check is in flight they stay hidden, so the nav never flashes four links at
  // a student and then collapses to one.
  const showPrivate = auth.phase === 'open';
  const items = NAV.filter((n) => !n.private || showPrivate || path === n.href);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <BrandLogo idPrefix="hb" />
        </div>
        <div className="brand-text">
          <div className="brand-title">SVPCET Bus</div>
          <div className="brand-sub">{subtitle ?? 'Puttur · live tracking'}</div>
        </div>
      </div>
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
    </header>
  );
}
