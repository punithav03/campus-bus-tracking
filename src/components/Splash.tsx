'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Launch animation: the icon fills the screen, then shrinks smoothly into the
 * header and becomes the app's mark.
 *
 * It is a FLIP — the logo is measured against the real header mark and animated
 * to exactly that rectangle, so it lands ON it rather than near it.
 *
 * Two things matter for it to read as ONE object moving:
 *   · the logo stays fully opaque for the whole flight. Only the backdrop
 *     fades. Fading the logo out mid-flight makes it vanish and the header mark
 *     appear, which reads as two objects swapping.
 *   · the swap happens AFTER the flight has landed, not before. Unmounting even
 *     a few frames early leaves a visible gap at the destination.
 */

const HOLD_MS = 640;   // let the logo be seen before it moves
const FLY_MS = 760;    // the flight itself — unhurried, it is the first impression
const KEY = 'campusbus.splashShown';

export function Splash() {
  const [phase, setPhase] = useState<'hidden' | 'hold' | 'fly' | 'done'>('hidden');
  const logo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem(KEY) === '1'; } catch { /* private mode */ }
    if (seen) { setPhase('done'); return; }
    try { sessionStorage.setItem(KEY, '1'); } catch { /* fine */ }

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.splash = 'running';
    setPhase('hold');

    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = () => {
      document.documentElement.dataset.splash = 'done';
      setPhase('done');
    };

    timers.push(setTimeout(() => {
      if (still) { finish(); return; }

      const el = logo.current;
      const target = document.querySelector<HTMLElement>('.brand-mark');
      if (!el || !target) { finish(); return; }

      const from = el.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      if (!to.width) { finish(); return; }

      const scale = to.width / from.width;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);

      // No overshoot: a launch mark that bounces on arrival looks unstable.
      // Slow out of the hold, decisive through the middle, settling at the end.
      el.style.transition =
        `transform ${FLY_MS}ms cubic-bezier(.55,.02,.18,1), ` +
        `box-shadow ${FLY_MS}ms ease-out`;
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
      el.style.boxShadow = 'none';
      setPhase('fly');

      // Swap only once it has actually arrived.
      timers.push(setTimeout(finish, FLY_MS + 40));
    }, HOLD_MS));

    return () => {
      timers.forEach(clearTimeout);
      document.documentElement.dataset.splash = 'done';
    };
  }, []);

  if (phase === 'done' || phase === 'hidden') return null;

  return (
    <div className="splash" data-phase={phase} aria-hidden>
      <div className="splash-bg" />
      <div className="splash-stage">
        <div className="splash-logo" ref={logo}>
          {/* Inlined rather than an <img>: an external file can arrive a frame
              late, and a launch screen that flickers is worse than none. */}
          <svg viewBox="0 0 512 512" width="100%" height="100%">
            <rect width="512" height="512" rx="112" fill="#FFFFFF" />
            <g transform="translate(256 262) scale(0.78) translate(-256 -256)">
              <defs>
                <path
                  id="sp-pin"
                  d="M256 26c95 0 172 77 172 172 0 62-50 140-149 236a33 33 0 0 1-46 0C134 338 84 260 84 198 84 103 161 26 256 26z"
                />
                <clipPath id="sp-l"><rect x="0" y="0" width="256" height="512" /></clipPath>
                <clipPath id="sp-r"><rect x="256" y="0" width="256" height="512" /></clipPath>
              </defs>
              <use href="#sp-pin" fill="#F5B301" clipPath="url(#sp-l)" />
              <use href="#sp-pin" fill="#16305B" clipPath="url(#sp-r)" />
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
        <div className="splash-word">Campus Bus</div>
      </div>
    </div>
  );
}
