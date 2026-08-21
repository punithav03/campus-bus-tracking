'use client';

import { clockAt, fmtClock, fmtEta } from '@/lib/format';
import type { StopView } from '@/lib/types';

export interface Sample { profile: number | null; naive: number | null }

/**
 * The thesis of the project, on one card.
 *
 * Both numbers are computed from the identical stream of GPS fixes. The naive
 * one divides remaining distance by current speed — so it lurches every time
 * the bus slows for a junction or halts at a stop. The profile model asks how
 * long this stretch of road has taken before, and rescales by how the bus is
 * running today, so it stays steady.
 */
export function Compare({
  stop,
  now,
  color,
  history,
  accuracy,
}: {
  stop: StopView | null;
  now: number;
  color: string;
  history: Sample[];
  accuracy: { model: string; n: number; maeS: number }[];
}) {
  if (!stop) return null;

  const prof = accuracy.find((a) => a.model === 'profile');
  const naive = accuracy.find((a) => a.model === 'naive');
  const scored = (prof?.n ?? 0) > 0;

  // There is no "time until arrival" for a stop the bus is already past. Saying
  // so is far more useful than three dashes and an empty chart, which just look
  // like something is broken.
  if (stop.passed) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-title">Two ways to compute the same ETA</span>
        </div>
        <div className="card-body">
          <div className="empty" style={{ padding: '28px 8px' }}>
            <strong style={{ color: 'var(--text)', fontSize: 15 }}>
              Bus has passed {stop.name}
              {stop.arrivedAt ? ` at ${fmtClock(stop.arrivedAt)}` : ''}
            </strong>
            <br />
            Pick a stop further along the route to compare arrival times.
          </div>
          {scored && <Scorecard prof={prof!} naive={naive} />}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Two ways to compute the same ETA</span>
      </div>
      <div className="card-body">
        <div className="cmp">
          <div className="cmp-row" data-hero="true">
            <div className="cmp-label">
              Ours
              <small>Route time profile, rescaled to today&apos;s pace</small>
            </div>
            <div className="cmp-val num" style={{ color }}>
              {stop.etaS == null ? '—' : fmtEta(stop.etaS)}
            </div>
          </div>

          <div className="cmp-row" data-weak="true">
            <div className="cmp-label">
              Naive
              <small>Remaining distance ÷ current speed</small>
            </div>
            <div className="cmp-val num">
              {stop.etaNaiveS == null ? '—' : fmtEta(stop.etaNaiveS)}
            </div>
          </div>

          <div className="cmp-row" data-weak="true">
            <div className="cmp-label">
              Timetable
              <small>What the printed schedule promises</small>
            </div>
            <div className="cmp-val num">
              {stop.passed ? '—' : clockAt(now, stop.etaS)}
            </div>
          </div>
        </div>

        <EtaSpark history={history} color={color} />

        <div className="spark-legend">
          <span className="spark-key" style={{ color }}>
            <i /> ours
          </span>
          <span className="spark-key" style={{ color: 'var(--dimmer)' }}>
            <i /> naive
          </span>
          <span style={{ marginLeft: 'auto' }}>last {history.length} updates</span>
        </div>

        {scored && <Scorecard prof={prof!} naive={naive} />}
      </div>
    </div>
  );
}

/** The self-scored result. Stays meaningful even once your stop is behind. */
function Scorecard({ prof, naive }: {
  prof: { maeS: number; n: number };
  naive?: { maeS: number; n: number };
}) {
  return (
    <div className="note" style={{ marginTop: 14 }}>
      Measured against stops the bus has already reached:{' '}
      <strong style={{ color: 'var(--text)' }}>ours is off by {prof.maeS}s on average</strong>
      {naive && naive.n > 0 && <> · naive is off by {naive.maeS}s</>} ({prof.n} predictions
      scored). The tracker grades its own homework — that is how it gets better.
    </div>
  );
}

/** Two lines on one shared scale — the jitter is the whole point. */
function EtaSpark({ history, color }: { history: Sample[]; color: string }) {
  const W = 320;
  const H = 62;
  if (history.length < 2) {
    return (
      <div className="spark" style={{ display: 'grid', placeItems: 'center', color: 'var(--dimmer)', fontSize: 12 }}>
        collecting…
      </div>
    );
  }

  const vals = history.flatMap((h) => [h.profile, h.naive]).filter((v): v is number => v != null);
  const max = Math.max(...vals, 60);
  const min = 0;

  const path = (key: keyof Sample) => {
    const pts: string[] = [];
    history.forEach((h, i) => {
      const v = h[key];
      if (v == null) return;
      const x = (i / (history.length - 1)) * W;
      const y = H - 4 - ((v - min) / (max - min || 1)) * (H - 10);
      pts.push(`${pts.length ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(' ');
  };

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={path('naive')} fill="none" stroke="var(--dimmer)" strokeWidth="1.6" />
      <path d={path('profile')} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}
