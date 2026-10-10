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

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
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
            onClick={() => { haptic('tick'); setTheme(v); applyTheme(v); }}
          >
            {v === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>
    </div>
  );
}
