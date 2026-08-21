'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The draggable sheet every transit and ride app uses on mobile.
 *
 * The map owns the screen; the content rides over it in a panel you can pull to
 * three heights — a peek that shows only the arrival time, a half view for the
 * stop list, and full for everything. It means the map is never a small box in
 * a page: it is the page, and the detail comes to you.
 *
 * Deliberately built on pointer events rather than a library: it is ~120 lines,
 * has no dependency, and gives exact control over the snap feel.
 */

const SNAPS = [0.16, 0.55, 0.94] as const; // fraction of the viewport the sheet covers
const MAX = SNAPS[SNAPS.length - 1];

export function BottomSheet({
  children,
  enabled,
  peekLabel,
}: {
  children: React.ReactNode;
  /** False on desktop — the sheet becomes a plain container. */
  enabled: boolean;
  peekLabel?: React.ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState(1);
  const [dragging, setDragging] = useState(false);

  const drag = useRef<{ startY: number; startOffset: number; lastY: number; lastT: number; v: number } | null>(null);
  const offset = useRef(0);

  const vh = () => (typeof window === 'undefined' ? 800 : window.innerHeight);
  const offsetFor = useCallback((i: number) => (MAX - SNAPS[i]) * vh(), []);

  const apply = useCallback((px: number, animate: boolean) => {
    const el = sheet.current;
    if (!el) return;
    offset.current = px;
    el.style.transition = animate ? 'transform .42s cubic-bezier(.16,1,.3,1)' : 'none';
    el.style.transform = `translate3d(0, ${px}px, 0)`;
  }, []);

  useEffect(() => {
    if (!enabled) {
      const el = sheet.current;
      if (el) { el.style.transform = ''; el.style.transition = ''; }
      return;
    }
    apply(offsetFor(snap), true);
  }, [enabled, snap, apply, offsetFor]);

  useEffect(() => {
    if (!enabled) return;
    const onResize = () => apply(offsetFor(snap), false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled, snap, apply, offsetFor]);

  const settle = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;

    // A decisive flick should win over proximity — otherwise a fast short swipe
    // snaps back to where it started and feels broken.
    const flick = Math.abs(d.v) > 0.55;
    let target = snap;
    if (flick) {
      target = d.v > 0 ? Math.max(0, snap - 1) : Math.min(SNAPS.length - 1, snap + 1);
    } else {
      let best = 0, bestGap = Infinity;
      for (let i = 0; i < SNAPS.length; i++) {
        const gap = Math.abs(offsetFor(i) - offset.current);
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      target = best;
    }
    setSnap(target);
    apply(offsetFor(target), true);
    if (target !== snap) navigator.vibrate?.(8);
  }, [snap, apply, offsetFor]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled) return;
    // Drag ONLY from the grip. The earlier version tried to arbitrate between
    // scrolling and dragging inside the content, which meant the list simply
    // refused to move at the lower snaps — it felt stuck. Content now always
    // scrolls; the handle always drags. Two gestures, no negotiation.
    if (!(e.target as HTMLElement).closest('.sheet-grip')) return;

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {
      startY: e.clientY, startOffset: offset.current,
      lastY: e.clientY, lastT: performance.now(), v: 0,
    };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY; d.lastT = now;

    const max = offsetFor(0);
    let next = d.startOffset + dy;
    // Rubber band past the ends rather than stopping dead.
    if (next < 0) next = next * 0.32;
    if (next > max) next = max + (next - max) * 0.32;
    apply(next, false);
  };

  // The same DOM is rendered in both modes on purpose. Returning different
  // markup for desktop would mean the server sends one layout and hydration
  // swaps in another — a visible jump on every phone load. CSS decides whether
  // this behaves as a sheet; `display: contents` makes it vanish on desktop.
  return (
    <div
      ref={sheet}
      className="sheet"
      data-enabled={enabled}
      data-dragging={dragging}
      data-snap={snap}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={settle}
      onPointerCancel={settle}
      style={enabled ? { height: `${MAX * 100}dvh` } : undefined}
    >
      <div className="sheet-grip" role="button" tabIndex={enabled ? 0 : -1} aria-hidden={!enabled} aria-label="Drag to resize"
           onClick={() => setSnap((s) => (s >= SNAPS.length - 1 ? 0 : s + 1))}
           onKeyDown={(e) => {
             if (e.key === 'ArrowUp') setSnap((s) => Math.min(SNAPS.length - 1, s + 1));
             if (e.key === 'ArrowDown') setSnap((s) => Math.max(0, s - 1));
           }}>
        <span className="sheet-bar" />
        {snap === 0 && peekLabel && <div className="sheet-peek">{peekLabel}</div>}
      </div>

      <div className="sheet-body" ref={scroller}>
        {children}
      </div>
    </div>
  );
}

/** Matches a CSS media query, in sync with the stylesheet's breakpoints. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
