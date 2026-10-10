'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtEta, fmtClock } from '@/lib/format';
import { haptic } from '@/lib/device';
import type { StopView } from '@/lib/types';

const ROW_H = 42;

/**
 * The vertical strip map — the view transit riders actually read.
 * A geographic map answers "where is the bus"; this answers "how many stops
 * until mine", which is the question people are really asking at a bus stop.
 */
export function StripMap({
  stops,
  color,
  myStopId,
  onPick,
  busDistM,
  hasTrip,
}: {
  stops: StopView[];
  color: string;
  myStopId: string | null;
  /**
   * Picking a boarding point is a student's business. A driver is on the bus
   * and the office is watching the fleet — neither boards anywhere, so for
   * them the list is a timetable to read, not a control. Passing null makes
   * every row inert: not a button, not focusable, no hover, no hint that
   * tapping would do something.
   */
  onPick: ((id: string) => void) | null;
  busDistM: number | null;
  hasTrip: boolean;
}) {
  // A stop going from ahead to passed is the one moment on this screen worth
  // marking. Diff it here rather than reading it off the server, because the
  // server only reports state — it has no idea what the screen showed a second
  // ago, and the transition is what the animation needs.
  const seen = useRef<Set<string>>(new Set());
  /** First poll only tells us what is ALREADY passed — that is state, not news. */
  const primed = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [justPassed, setJustPassed] = useState<Set<string>>(new Set());

  /**
   * Bring the student's own stop into view.
   *
   * The list is 21 rows long and opens at the top, so a student boarding at
   * Pichatur arrived looking at Nagalapuram and had to scroll to find the one
   * row on the screen that is about them. Their stop should simply be there.
   *
   * Only once per stop, and only when it is actually off screen: scrolling a
   * list a student is already reading, every time the bus moves, would be
   * worse than the problem.
   */
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    if (!myStopId || !stops.length) return;
    if (scrolledTo.current === myStopId) return;

    const row = scroller.current
      ?.querySelector<HTMLElement>(`[data-stop="${CSS.escape(myStopId)}"]`);
    if (!row) return;

    // Which element actually scrolls varies: on a wide screen the strip has
    // its own max-height and scrolls, on a phone it sits inside the bottom
    // sheet and the sheet scrolls. Walk up and find whichever one really
    // does, rather than assuming — scrolling the wrong box moves nothing.
    let box: HTMLElement | null = row.parentElement;
    while (box) {
      const oy = getComputedStyle(box).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight + 4) break;
      box = box.parentElement;
    }

    const first = scrolledTo.current === null;
    scrolledTo.current = myStopId;

    if (!box) {
      // Nothing scrolls on its own — the page does. Only nudge it if the row
      // is genuinely off screen; yanking the viewport on load is worse than
      // a little scrolling.
      const r = row.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) return;
      row.scrollIntoView({ block: 'center', behavior: first ? 'auto' : 'smooth' });
      return;
    }

    const rTop = row.offsetTop - box.offsetTop;
    if (rTop >= box.scrollTop && rTop + row.offsetHeight <= box.scrollTop + box.clientHeight) return;

    // A little above centre, so the stops still to come are what you see.
    box.scrollTo({
      top: Math.max(0, rTop - box.clientHeight * 0.38),
      behavior: first ? 'auto' : 'smooth',
    });
  }, [myStopId, stops.length]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    if (!stops.length) return;
    const fresh: string[] = [];
    for (const s of stops) {
      if (s.passed && !seen.current.has(s.id)) {
        if (primed.current) fresh.push(s.id);
        seen.current.add(s.id);
      }
      if (!s.passed) seen.current.delete(s.id);
    }
    primed.current = true;
    if (!fresh.length) return;

    // Feel it if it was YOUR stop; the rest are just visual.
    // 'select', not 'alert' — alert means LEAVE NOW. This is a confirmation.
    if (onPick && myStopId && fresh.includes(myStopId)) haptic('select');

    setJustPassed((prev) => new Set([...prev, ...fresh]));
    // The timer is owned by the component, not by this effect run. Returning it
    // as cleanup would mean the very next poll cancels it and the flag sticks on
    // forever, which is how the row ended up permanently mid-animation.
    timers.current.push(setTimeout(() => {
      setJustPassed((prev) => {
        const next = new Set(prev);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
    }, 1400));
  }, [stops, myStopId]);

  // Where the bus puck sits on the rail: interpolate between the two stops it
  // is currently between, so it slides smoothly rather than jumping row to row.
  let busTop: number | null = null;
  if (hasTrip && busDistM != null && stops.length > 1) {
    let idx = 0;
    while (idx < stops.length - 1 && stops[idx + 1].distAlongM <= busDistM) idx++;
    const a = stops[idx];
    const b = stops[Math.min(idx + 1, stops.length - 1)];
    const span = b.distAlongM - a.distAlongM || 1;
    const f = idx + Math.max(0, Math.min(1, (busDistM - a.distAlongM) / span));
    busTop = f * ROW_H + ROW_H / 2 - 13;
  }

  return (
    <div className="strip" ref={scroller} style={{ position: 'relative' }}>
      {busTop != null && (
        <div className="strip-bus" style={{ top: busTop }}>
          <div className="strip-bus-puck" style={{ ['--c' as string]: color }}>🚌</div>
        </div>
      )}

      {stops.map((s) => (
        <div
          key={s.id}
          data-stop={s.id}
          className="strow"
          style={{ ['--c' as string]: color, height: ROW_H }}
          data-passed={s.passed}
          data-just={justPassed.has(s.id) || undefined}
          data-mine={!!onPick && s.id === myStopId}
          data-pick={!!onPick}
          {...(onPick
            ? {
                onClick: () => onPick(s.id),
                role: 'button' as const,
                tabIndex: 0,
                onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') onPick(s.id); },
              }
            : {})}
        >
          <div className="strow-rail">
            <div className="strow-node">
              <span className="strow-ping" />
            </div>
          </div>
          <div className="strow-name">
            {s.name}
            {s.estimated && (
              <span
                title="Position estimated — recording the route will place it exactly"
                style={{ color: 'var(--dimmer)', marginLeft: 6, fontSize: 11 }}
              >
                ~
              </span>
            )}
          </div>
          {s.passed ? (
            <div
              className="strow-eta-passed num"
              title={
                s.halted === false ? 'Went past without stopping'
                  : s.halted ? 'Stopped here'
                  : undefined
              }
            >
              {s.arrivedAt ? fmtClock(s.arrivedAt) : 'passed'}
            </div>
          ) : (
            <div className="strow-eta num">{fmtEta(s.etaS)}</div>
          )}
        </div>
      ))}
    </div>
  );
}
