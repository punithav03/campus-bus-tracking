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

/** Pull-to-refresh: how far to drag before it fires, and where it rests while working. */
const PTR_TRIGGER = 72;
const PTR_REST = 56;
/** Even an instant reply holds briefly — a flash that never resolves reads as a glitch. */
const PTR_MIN_MS = 750;

export function BottomSheet({
  children,
  enabled,
  peekLabel,
  onRefresh,
}: {
  children: React.ReactNode;
  /** False on desktop — the sheet becomes a plain container. */
  enabled: boolean;
  peekLabel?: React.ReactNode;
  /** Pull down at the top of the list to run this. */
  onRefresh?: () => Promise<void>;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState(1);
  const [dragging, setDragging] = useState(false);

  const drag = useRef<{ startY: number; startOffset: number; lastY: number; lastT: number; v: number } | null>(null);
  const offset = useRef(0);

  // ---- pull to refresh -----------------------------------------------------
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const busy = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  pullRef.current = pull;

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

  useEffect(() => {
    const el = scroller.current;
    if (!el || !enabled || !onRefresh) return;

    // Native listeners, because React's are passive and a passive listener
    // cannot preventDefault — without that the browser scroll-chains to the
    // page behind and the pull never gets off the ground.
    let startY = 0;
    let active = false;   // committed to a pull, not a scroll

    const down = (e: TouchEvent) => {
      if (busy.current || el.scrollTop > 0) return;
      startY = e.touches[0].clientY;
      active = true;
    };

    const move = (e: TouchEvent) => {
      if (!active || busy.current) return;
      const dy = e.touches[0].clientY - startY;
      // Upward, or the list has scrolled — this was a scroll all along.
      if (dy <= 0 || el.scrollTop > 0) { active = false; setPull(0); return; }
      e.preventDefault();
      // Resistance, then heavier resistance past the trigger, so the point it
      // will fire is something you can feel rather than a number you guess.
      const raw = dy * 0.55;
      setPull(raw > PTR_TRIGGER ? PTR_TRIGGER + (raw - PTR_TRIGGER) * 0.35 : raw);
    };

    const up = async () => {
      if (!active) return;
      active = false;
      if (pullRef.current < PTR_TRIGGER) { setPull(0); return; }

      busy.current = true;
      setRefreshing(true);
      setPull(PTR_REST);
      navigator.vibrate?.(10);
      const began = performance.now();
      try { await refreshRef.current?.(); } catch { /* keep the old data */ }
      const left = PTR_MIN_MS - (performance.now() - began);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      setRefreshing(false);
      setPull(0);
      busy.current = false;
    };

    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
    return () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
    };
  }, [enabled, onRefresh]);

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

      {enabled && onRefresh && (
        <div
          className="sheet-ptr"
          data-on={refreshing || undefined}
          style={{ height: pull, marginBottom: -pull, ['--p' as string]: Math.min(1, pull / PTR_TRIGGER) }}
          aria-hidden
        >
          <span className="ptr-road" />
          <span className="ptr-bus">
            <svg viewBox="0 0 34 20" width="34" height="20">
              <rect x="1" y="3" width="30" height="12" rx="3.5" fill="currentColor" />
              <rect x="21.5" y="5.5" width="7.5" height="5" rx="1.6" fill="rgba(255,255,255,.9)" />
              <rect x="4" y="5.5" width="14" height="5" rx="1.6" fill="rgba(255,255,255,.55)" />
              <circle cx="8" cy="16" r="2.6" fill="currentColor" />
              <circle cx="24" cy="16" r="2.6" fill="currentColor" />
            </svg>
          </span>
        </div>
      )}

      <div
        className="sheet-body"
        ref={scroller}
        // A transform is applied ONLY while the pull is actually live. A resting
        // translate3d(0,0,0) would make this a containing block for anything
        // fixed inside it — cheap to avoid, expensive to debug.
        style={
          pull > 0
            ? { transform: `translate3d(0,${pull}px,0)`, transition: refreshing ? 'transform .38s cubic-bezier(.16,1,.3,1)' : 'none' }
            : { transform: '', transition: 'transform .38s cubic-bezier(.16,1,.3,1)' }
        }
      >
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
