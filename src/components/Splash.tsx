'use client';

import { useEffect } from 'react';

/**
 * Controls the launch screen. It does NOT render it.
 *
 * The screen itself is server-rendered in layout.tsx, and that is the entire
 * point of this rewrite. When this component rendered its own overlay, the
 * overlay could only appear after React had hydrated, so an installed app
 * launched like this:
 *
 *     Android's own splash  ->  a flash of the empty dark shell
 *     ("0 stops · 0.0 km")  ->  our logo appears  ->  it flies away
 *
 * The logo showed up SECOND, after a flash of empty app. That is the stutter.
 * Now the logo is in the first HTML the browser paints, so it continues
 * seamlessly out of the OS splash (same background colour, same mark) and
 * there is nothing to flash in between.
 *
 * This component's only job is to end it: wait for the app to actually have
 * something to show, then fly the logo into the header mark and remove it.
 */

const KEY = 'campusbus.splashShown';
const MIN_HOLD_MS = 520;    // long enough to read as intentional, not a flicker
/**
 * The ceiling on waiting for content. Deliberately short: past about a second
 * and a half a launch screen stops reading as "opening" and starts reading as
 * "stuck", which is the whole complaint this rewrite exists to fix. If the data
 * is not there by now, lift anyway — the screen underneath says "Checking for
 * the bus…" and an honest waiting state beats a frozen logo.
 */
const MAX_HOLD_MS = 1600;
const FLY_MS = 700;

export function Splash() {
  useEffect(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;

    let done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const remove = () => {
      if (done) return;
      done = true;
      document.documentElement.dataset.splash = 'done';
      // Hidden, NOT removed. #boot is server-rendered by layout.tsx, so React
      // owns that node; calling .remove() on it left React's tree and the real
      // DOM disagreeing, and the next client-side navigation threw
      // "insertBefore: the node before which the new node is to be inserted is
      // not a child of this node" while it tried to reconcile around a sibling
      // that no longer existed. It is position:fixed and display:none, so
      // leaving it in costs nothing.
      boot.dataset.phase = 'gone';
      try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode */ }
    };

    // Already seen this session (a client-side navigation, or a reload): the
    // inline script in <head> has hidden it, so just drop it.
    if (document.documentElement.dataset.splash === 'skip') { remove(); return; }

    document.documentElement.dataset.splash = 'running';

    const fly = () => {
      if (done) return;
      const logo = document.getElementById('boot-logo');
      const target = document.querySelector<HTMLElement>('.brand-mark');
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (still || !logo || !target) { remove(); return; }

      const from = logo.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      if (!to.width || !from.width) { remove(); return; }

      const scale = to.width / from.width;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);

      boot.dataset.phase = 'fly';
      // No overshoot: a launch mark that bounces on arrival looks unstable.
      logo.style.transition =
        `transform ${FLY_MS}ms cubic-bezier(.55,.02,.18,1), box-shadow ${FLY_MS}ms ease-out`;
      logo.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
      logo.style.boxShadow = 'none';

      // Swap only once it has actually landed. Unmounting even a few frames
      // early leaves a visible gap at the destination.
      timers.push(setTimeout(remove, FLY_MS + 60));
    };

    // Hold until the app has real content, so what the logo uncovers is the
    // finished screen rather than "0 stops · 0.0 km" — but never longer than
    // MAX_HOLD_MS, because a launch screen that waits on the network is
    // exactly the thing that feels stuck.
    const started = performance.now();
    // Only the Track screen loads geometry worth waiting for; /drive, /record
    // and /admin are ready as soon as they are on screen.
    const ready = () =>
      document.documentElement.dataset.ready === '1' || window.location.pathname !== '/';

    const check = () => {
      if (done) return;
      const waited = performance.now() - started;
      if (waited < MIN_HOLD_MS) { timers.push(setTimeout(check, MIN_HOLD_MS - waited)); return; }
      if (ready() || waited >= MAX_HOLD_MS) { fly(); return; }
      timers.push(setTimeout(check, 80));
    };
    check();

    return () => {
      timers.forEach(clearTimeout);
      document.documentElement.dataset.splash = 'done';
    };
  }, []);

  return null;
}
