'use client';

import { useState } from 'react';
import { haptic } from '@/lib/device';

/**
 * Drive a route from start to finish, without a bus.
 *
 * Demonstrating this app has a chicken-and-egg problem: the thing worth
 * showing is a bus moving down a road, and there is no bus at 4pm in the
 * principal's office. Route 1 replays an actual recorded ride — GPS noise,
 * railway gate and all. The others drive their own road line at the pace
 * their timetable implies.
 *
 * It is labelled DEMO everywhere it appears, deliberately. A fake bus that
 * looked real would eventually be mistaken for one, and somebody would walk
 * to a stop because of it.
 *
 * To remove for production: delete this component, the two lines that render
 * it on the fleet page, and src/lib/demo-run.ts.
 */
export function DemoRun({ routeId, running }: { routeId: string; running: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(action: 'replay' | 'stop-replay', speed?: number, skipSpur = false) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    haptic('select');
    try {
      const r = await fetch(`/api/trip?route=${routeId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, speed, skipSpur }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error ?? 'Could not start the demo.');
    } catch {
      setErr('No connection.');
    }
    setBusy(false);
  }

  return (
    <div className="dr" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <span className="dr-tag">DEMO</span>
      {running ? (
        <button className="dr-btn" data-stop="true" disabled={busy}
                onClick={() => void send('stop-replay')}>
          Stop demo
        </button>
      ) : (
        <>
          <button className="dr-btn" disabled={busy} onClick={() => void send('replay', 30)}>
            {busy ? 'Starting…' : 'Run route'}
          </button>
          {/* The full run is 80-odd minutes of road. 30x covers it in under
              three, which is about as long as anyone will watch; 120x is for
              getting to the end of the line to show the auto-finish. */}
          <button className="dr-btn dr-fast" disabled={busy}
                  onClick={() => void send('replay', 120)}>
            Fast
          </button>
          {/* The same ride, but the bus carries straight on past a village
              nobody is waiting at. Shows the map keeping the bus on the road
              it really took and the skipped stops saying so. */}
          <button className="dr-btn" disabled={busy}
                  title="Replay with the bus skipping a village spur"
                  onClick={() => void send('replay', 30, true)}>
            Skip a village
          </button>
        </>
      )}
      {err && <span className="dr-err">{err}</span>}
    </div>
  );
}
