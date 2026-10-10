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

    /**
     * Where the launch mark is flying TO.
     *
     * Whichever mark this screen actually shows. On the login page that is
     * the one on the card; everywhere else it is the one in the header. It
     * used to look only for the header, so on the very first open — which is
     * always the login page — there was nothing to fly to and the splash
     * just vanished.
     */
    const findTarget = () =>
      document.querySelector<HTMLElement>('.login-mark, .brand-mark');

    const fly = () => {
      if (done) return;
      const logo = document.getElementById('boot-logo');
      const target = findTarget();
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

    /**
     * Ready means two things, and it used to only check one.
     *
     * The screen has to have something worth revealing — only Track loads
     * geometry worth waiting for — AND the mark it will fly into has to be
     * on screen. Without the second test the animation fired before the
     * login card had rendered, found nothing to aim at, and fell back to
     * simply disappearing. Which is the whole effect, missing, on the first
     * screen anyone ever sees.
     */
    /**
     * Only the map is worth waiting for.
     *
     * Track draws a route and a bus, and lifting the logo before that lands
     * reveals an empty map — so it waits for the page to say it is ready.
     * Every other screen is its own content: once the shell has painted
     * there is nothing further to wait for, and holding the launch screen
     * while a background fetch finishes is exactly what makes an app feel
     * slow. Home used to sit for its full ceiling for no reason at all.
     */
    const contentReady = () =>
      !window.location.pathname.startsWith('/track')
      || document.documentElement.dataset.ready === '1';
    const ready = () => contentReady() && !!findTarget();

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
