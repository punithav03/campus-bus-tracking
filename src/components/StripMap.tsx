'use client';

import { fmtEta, fmtClock } from '@/lib/format';
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
  onPick: (id: string) => void;
  busDistM: number | null;
  hasTrip: boolean;
}) {
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
    <div className="strip" style={{ position: 'relative' }}>
      {busTop != null && (
        <div className="strip-bus" style={{ top: busTop }}>
          <div className="strip-bus-puck" style={{ ['--c' as string]: color }}>🚌</div>
        </div>
      )}

      {stops.map((s) => (
        <div
          key={s.id}
          className="strow"
          style={{ ['--c' as string]: color, height: ROW_H }}
          data-passed={s.passed}
          data-mine={s.id === myStopId}
          onClick={() => onPick(s.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onPick(s.id)}
        >
          <div className="strow-rail">
            <div className="strow-node" />
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
            <div className="strow-eta-passed num">
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
