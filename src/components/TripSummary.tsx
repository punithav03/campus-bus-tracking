'use client';

import { haptic } from '@/lib/device';

/**
 * What the driver sees when he presses End trip.
 *
 * He has just driven forty kilometres and served twenty-one stops, and until
 * now the app's entire response was for the button to change colour. This is
 * not analytics — it is the acknowledgement that the run happened and went
 * well, which is the difference between a tool he tolerates and one he is
 * glad to use.
 */
export interface Summary {
  stops: number;
  startedAt: string | null;
  endedAt: string | null;
  avgDelayS: number | null;
}

const clock = (iso: string | null) =>
  (iso ? new Date(iso).toLocaleTimeString('en-IN',
    { hour: '2-digit', minute: '2-digit', hour12: false }) : '—');

export function TripSummary({ summary, onDone }: { summary: Summary; onDone: () => void }) {
  const mins = summary.startedAt && summary.endedAt
    ? Math.round((new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 60000)
    : null;

  const d = summary.avgDelayS;
  const verdict = d == null ? null
    : Math.abs(d) < 120 ? { text: 'On time', tone: 'var(--live)' }
    : d < 0 ? { text: `${Math.round(-d / 60)} min early`, tone: 'var(--live)' }
    : { text: `${Math.round(d / 60)} min late`, tone: 'var(--warn)' };

  return (
    <div className="cf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <div className="cf-panel ts" role="dialog" aria-modal="true" aria-labelledby="ts-t">
        <div className="ts-tick" aria-hidden>
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path d="m5 12.6 4.4 4.4L19 7.4" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h2 className="cf-title ts-title" id="ts-t">Run finished</h2>

        <div className="ts-grid">
          <div className="ts-cell">
            <div className="ts-v num">{summary.stops}</div>
            <div className="ts-k">stops served</div>
          </div>
          <div className="ts-cell">
            <div className="ts-v num">{mins == null ? '—' : mins}</div>
            <div className="ts-k">minutes</div>
          </div>
          <div className="ts-cell">
            <div className="ts-v num" style={{ color: verdict?.tone }}>
              {verdict ? verdict.text.split(' ')[0] : '—'}
            </div>
            <div className="ts-k">{verdict && verdict.text.includes(' ') ? verdict.text.split(' ').slice(1).join(' ') : 'timing'}</div>
          </div>
        </div>

        <p className="ts-line">
          {clock(summary.startedAt)} → {clock(summary.endedAt)}
        </p>

        <div className="cf-actions">
          <button className="btn cf-btn" data-primary="true"
                  onClick={() => { haptic('select'); onDone(); }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
