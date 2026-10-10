'use client';

import { haptic } from '@/lib/device';
import { usePush } from '@/lib/usePush';

/**
 * Switching on the thing that means you never open the app again.
 *
 * Worded as a promise rather than a permission request, because that is what
 * it is: the student is not granting us access to anything, they are asking
 * to be told when their bus is close. The browser's own prompt is only
 * triggered by the button below, never on load — a denied prompt never comes
 * back, and burning it on someone who had not read the sentence yet is a
 * student lost for good.
 */
export function NotifyCard() {
  const { state, leadMin, error, enable, disable, setLead } = usePush();

  if (state === 'unsupported' || state === 'unavailable') return null;

  return (
    <section className="card enter nt" data-i="4">
      <div className="nt-head">
        <span className="nt-ic" data-on={state === 'on'} aria-hidden>
          <svg viewBox="0 0 24 24" width="19" height="19">
            <path d="M12 3.2a5.6 5.6 0 0 0-5.6 5.6c0 4.3-1.5 5.6-1.5 5.6h14.2s-1.5-1.3-1.5-5.6A5.6 5.6 0 0 0 12 3.2z"
                  fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M10.3 17.6a1.9 1.9 0 0 0 3.4 0" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </span>
        <div className="nt-text">
          <div className="nt-title">
            {state === 'on' ? 'You will be told' : 'Tell me when the bus is close'}
          </div>
          <div className="nt-sub">
            {state === 'on'
              ? `${leadMin} minutes before it reaches your stop — even with the app closed.`
              : state === 'blocked'
                ? 'Notifications are blocked for this site.'
                : 'A notification when it sets off, and again when it is nearly at your stop.'}
          </div>
        </div>
      </div>

      {state === 'on' && (
        <div className="nt-lead">
          <span className="field-label">Warn me {leadMin} min before</span>
          <input
            type="range" min={2} max={20} value={leadMin}
            onChange={(e) => void setLead(Number(e.target.value))}
          />
          <span className="nt-hint">
            Long walk to the stop? Ask for more warning.
          </span>
        </div>
      )}

      {state === 'blocked' && (
        <div className="note" style={{ margin: '0 17px 16px', borderLeftColor: 'var(--warn)' }}>
          Your browser is blocking them. Open the padlock beside the address,
          set Notifications to <strong>Allow</strong>, then reload.
        </div>
      )}

      {error && (
        <div className="note" style={{ margin: '0 17px 16px', borderLeftColor: 'var(--bad)' }}>
          {error}
        </div>
      )}

      {state !== 'blocked' && (
        <div className="nt-foot">
          <button
            className="btn"
            data-primary={state !== 'on' ? 'true' : undefined}
            disabled={state === 'working'}
            onClick={() => { haptic('select'); void (state === 'on' ? disable() : enable()); }}
          >
            {state === 'working' ? 'One moment…' : state === 'on' ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      )}
    </section>
  );
}
