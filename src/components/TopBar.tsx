'use client';

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
          <svg viewBox="0 0 512 512" aria-hidden>
            <rect width="512" height="512" rx="112" fill="#FFFFFF" />
            <g transform="translate(256 262) scale(0.78) translate(-256 -256)">
              <defs>
                <path
                  id="hb-pin"
                  d="M256 26c95 0 172 77 172 172 0 62-50 140-149 236a33 33 0 0 1-46 0C134 338 84 260 84 198 84 103 161 26 256 26z"
                />
                <clipPath id="hb-l"><rect x="0" y="0" width="256" height="512" /></clipPath>
                <clipPath id="hb-r"><rect x="256" y="0" width="256" height="512" /></clipPath>
              </defs>
              <use href="#hb-pin" fill="#F5B301" clipPath="url(#hb-l)" />
              <use href="#hb-pin" fill="#16305B" clipPath="url(#hb-r)" />
              <circle cx="256" cy="196" r="118" fill="#FFFFFF" />
              <rect x="186" y="112" width="140" height="150" rx="30" fill="#16305B" />
              <rect x="204" y="136" width="104" height="58" rx="12" fill="#FFFFFF" />
              <circle cx="212" cy="222" r="13" fill="#FFFFFF" />
              <circle cx="300" cy="222" r="13" fill="#FFFFFF" />
              <rect x="240" y="214" width="32" height="11" rx="5.5" fill="#FFFFFF" />
              <rect x="198" y="256" width="26" height="26" rx="8" fill="#16305B" />
              <rect x="288" y="256" width="26" height="26" rx="8" fill="#16305B" />
            </g>
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-title">Campus Bus</div>
          <div className="brand-sub">{subtitle ?? 'SVPCET · Puttur'}</div>
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
