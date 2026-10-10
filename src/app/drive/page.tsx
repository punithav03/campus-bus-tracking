'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { RoleGate } from '@/components/RoleGate';
import { Confirm } from '@/components/Confirm';
import { WaitingPanel } from '@/components/WaitingPanel';
import { TripSummary, type Summary } from '@/components/TripSummary';
import {
  getTripState, subscribeTrip, startTrip, endTrip, resumeTripIfRunning, type TripState,
} from '@/lib/trip-session';
import { useSession } from '@/lib/useSession';
import { haptic } from '@/lib/device';
import type { RouteSummary } from '@/lib/types';

/**
 * The driver's screen. One button, because he is about to drive a bus.
 *
 * There is no route chooser. The server already knows which bus is his, so
 * offering a dropdown would only create a way to get it wrong at 7am — and a
 * driver broadcasting on the wrong route sends every student on two routes to
 * the wrong place.
 *
 * It holds no tracking state of its own either. The trip lives in
 * trip-session, a module that outlives this page, because a trip belongs to
 * the phone and not to whichever screen happens to be open. He can switch to
 * Track to glance at his own bus, come back, and find it still running.
 */
function DriveInner() {
  const { user } = useSession();
  const [route, setRoute] = useState<RouteSummary | null>(null);
  const [t, setT] = useState<TripState>(getTripState);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [askEnd, setAskEnd] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  // Subscribe to the trip rather than own it — and pick one back up if the app
  // was closed mid-run. Android destroys the process when the app is swiped
  // out of recents; without this the driver would reopen to a Start button
  // with no idea he had been off the air since the last roundabout.
  useEffect(() => {
    setT(getTripState());
    const off = subscribeTrip(setT);
    void resumeTripIfRunning();
    return off;
  }, []);

  useEffect(() => {
    fetch('/api/network', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setRoute(j.routes?.[0] ?? null))
      .catch(() => setLoadErr('Could not load your route — check your connection.'));
  }, []);

  const routeId = route?.id ?? user?.routeId ?? '';
  const accent = route?.color ?? '#38bdf8';

  return (
    <div className="shell" style={{ ['--accent' as string]: accent, maxWidth: 560 }}>
      <TopBar subtitle="Driver" />

      <div className="card enter" data-i="0">
        <div className="card-head">
          <span className="card-title">Your bus</span>
          {t.running && (
            <span className="badge" data-tone="live" style={{ marginLeft: 'auto' }}>
              <span className="rec-dot" style={{ background: 'var(--live)' }} />on air
            </span>
          )}
        </div>

        <div className="dv-route">
          <span className="ti-badge" style={{ background: accent }}>{route?.code ?? '–'}</span>
          <div className="ti-route-text">
            <div className="ti-route-name">{route?.name ?? 'Loading…'}</div>
            <div className="ti-route-sub">
              {route ? `${route.stopCount} stops · ${(route.lengthM / 1000).toFixed(1)} km` : ''}
            </div>
          </div>
        </div>

        <div className="dv-action">
          {!t.running ? (
            <button
              className="btn dv-btn" data-primary="true"
              onClick={() => { haptic('select'); void startTrip(routeId); }}
              disabled={!routeId}
            >
              Start trip
            </button>
          ) : (
            <button
              className="btn dv-btn" data-danger="true"
              onClick={() => { haptic('tick'); setAskEnd(true); }}
            >
              End trip
            </button>
          )}
          <span className="dv-hint">
            {!t.running ? 'Uses this phone’s GPS'
              : t.background ? 'You can lock the phone'
              : 'Keep this screen on'}
          </span>
        </div>

        {t.running && (
          <div className="note" style={{ margin: '0 17px 17px',
                                         borderLeftColor: t.background ? 'var(--live)' : 'var(--warn)' }}>
            {t.background ? (
              <>
                <strong style={{ color: 'var(--live)' }}>Running in the background.</strong>{' '}
                Lock the phone and put it away — tracking continues, and it keeps going if you
                switch screens. It stops when you press End trip, or by itself when the bus
                reaches the college.
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--warn)' }}>Keep this screen on.</strong>{' '}
                In a browser the phone stops sharing location the moment the screen locks.
                Mount the phone and keep it charging — or install the driver app, which keeps
                running with the screen off.
              </>
            )}
          </div>
        )}

        {t.resumed && t.running && (
          <div className="note" style={{ margin: '0 17px 17px', borderLeftColor: 'var(--live)' }}>
            <strong style={{ color: 'var(--live)' }}>Trip picked back up.</strong>{' '}
            The app had closed, so broadcasting restarted on its own.
          </div>
        )}

        {t.arrived && !t.running && (
          <div className="note" style={{ margin: '0 17px 17px', borderLeftColor: 'var(--live)' }}>
            <strong style={{ color: 'var(--live)' }}>Trip finished.</strong>{' '}
            The bus reached the college, so broadcasting stopped by itself.
          </div>
        )}

        {(t.message || loadErr) && (
          <div className="note" style={{ margin: '0 17px 17px' }}>{t.message ?? loadErr}</div>
        )}

        {/* Ending early strands every student still waiting down the line,
            and the button sits where Start used to be. Worth one tap. */}
        <Confirm
          open={askEnd}
          title="End the trip?"
          danger
          confirmLabel="End trip"
          cancelLabel="Keep going"
          onCancel={() => setAskEnd(false)}
          onConfirm={() => {
            setAskEnd(false);
            void endTrip().then((s) => { if (s) setSummary(s as Summary); });
          }}
          body={
            <>Students will stop seeing the bus. If you have reached the college it
            ends by itself — you do not need to press this.</>
          }
        />

        <div className="stat-grid">
          <div className="stat">
            <div className="stat-k">Fixes</div>
            <div className="stat-v num">{t.captured}</div>
          </div>
          <div className="stat">
            <div className="stat-k">Sent</div>
            <div className="stat-v num">{t.accepted}</div>
          </div>
          <div className="stat">
            <div className="stat-k">Waiting</div>
            <div className="stat-v num" style={{ color: t.buffered > 20 ? 'var(--warn)' : undefined }}>
              {t.buffered}
            </div>
          </div>
          <div className="stat">
            <div className="stat-k">GPS ±</div>
            <div className="stat-v num">
              {t.lastAcc == null ? '—' : Math.round(t.lastAcc)}<small>m</small>
            </div>
          </div>
          <div className="stat">
            <div className="stat-k">Travelled</div>
            <div className="stat-v num">
              {t.distKm == null ? '—' : t.distKm.toFixed(1)}<small>km</small>
            </div>
          </div>
          <div className="stat">
            <div className="stat-k">Next stop</div>
            <div className="stat-v" style={{ fontSize: 13 }}>{t.nextStop ?? '—'}</div>
          </div>
        </div>
      </div>

      {t.running && <WaitingPanel />}
      {summary && <TripSummary summary={summary} onDone={() => setSummary(null)} />}
    </div>
  );
}

export default function DrivePage() {
  return (
    <RoleGate allow={['driver']}>
      <DriveInner />
    </RoleGate>
  );
}
