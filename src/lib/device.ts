'use client';

/**
 * Small wrappers over the browser capabilities that make a web page feel like
 * an app. Every one of them is free, and every one degrades to nothing on
 * devices that lack it — so none of them are ever worth a feature check at the
 * call site.
 */

type Pattern = 'tick' | 'select' | 'alert';

const PATTERNS: Record<Pattern, number | number[]> = {
  tick: 8,            // a snap, a toggle
  select: 14,         // a deliberate choice
  alert: [26, 60, 26], // leave now — should be felt through a pocket
};

/** Haptic feedback. Android only; silently ignored elsewhere. */
export function haptic(kind: Pattern = 'tick') {
  try {
    navigator.vibrate?.(PATTERNS[kind]);
  } catch { /* some browsers throw when the page is not focused */ }
}

/**
 * Minutes-to-bus on the home-screen icon. Only visible once the app is
 * installed, which is exactly when it is most useful — you see the number
 * without opening anything.
 */
export function setBadge(minutes: number | null) {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (minutes == null || minutes < 0) void nav.clearAppBadge?.();
    else void nav.setAppBadge?.(Math.min(99, Math.round(minutes)));
  } catch { /* not installed, or unsupported */ }
}

/** Native share sheet, falling back to the clipboard. Returns what happened. */
export async function share(title: string, text: string): Promise<'shared' | 'copied' | 'failed'> {
  const url = window.location.href;
  const nav = navigator as Navigator & {
    share?: (d: { title?: string; text?: string; url?: string }) => Promise<void>;
  };
  if (nav.share) {
    try {
      await nav.share({ title, text, url });
      return 'shared';
    } catch (e) {
      // A user cancelling the share sheet is not a failure worth reporting.
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    return 'copied';
  } catch {
    return 'failed';
  }
}
