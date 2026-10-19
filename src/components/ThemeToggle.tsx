'use client';

import { useEffect, useState } from 'react';
import { haptic } from '@/lib/device';

/**
 * Light or dark.
 *
 * The choice is written to <html data-theme> and mirrored to localStorage; a
 * script in the document head applies it before first paint, so there is no
 * flash of the wrong theme on the way in.
 */
export type Theme = 'dark' | 'light';

export const THEME_KEY = 'campusbus.theme';

/**
 * Switches theme with a transition you can feel: the new theme spreads out
 * from where you tapped, with a soft edge. Light "glows up": the screen
 * brightens a little past normal and settles. Dark spreads over the light
 * screen from the same point; the light part is left alone until the dark
 * edge reaches it, so the page never greys out all at once.
 *
 * Uses the View Transitions API: the browser snapshots the old page, applies
 * the change, and animates between the two images, so nothing on the page
 * has to know about it. Browsers without it get a plain colour fade; anyone
 * who asked their phone for reduced motion gets a short fade only.
 */
export function applyTheme(t: Theme, origin?: { x: number; y: number }) {
  const root = document.documentElement;
  const commit = () => {
    root.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  };
  const current = root.dataset.theme
    ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (current === t) { commit(); return; }

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vt = (document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  }).startViewTransition?.bind(document);

  if (!vt || reduce) {
    root.classList.add('theme-fade');
    commit();
    setTimeout(() => root.classList.remove('theme-fade'), reduce ? 250 : 700);
    return;
  }

  const x = origin?.x ?? innerWidth / 2;
  const y = origin?.y ?? innerHeight / 2;
  // Far enough to cover the furthest corner from the tap, plus the soft edge.
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.style.setProperty('--tx', `${x}px`);
  root.style.setProperty('--ty', `${y}px`);
  root.style.setProperty('--tr', `${Math.ceil(r)}px`);
  root.dataset.themeTo = t;
  vt(commit).finished.finally(() => { delete root.dataset.themeTo; });
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') setTheme(saved);
    } catch { /* default */ }
  }, []);

  return (
    <div className="th">
      <div className="th-row" role="radiogroup" aria-label="Theme">
        {(['light', 'dark'] as Theme[]).map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={theme === v}
            className="th-opt"
            data-on={theme === v}
            onClick={(e) => {
              haptic('tick');
              setTheme(v);
              const r = e.currentTarget.getBoundingClientRect();
              applyTheme(v, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}
          >
            {v === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>
    </div>
  );
}
