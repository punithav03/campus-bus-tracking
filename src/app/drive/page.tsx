'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { PinGate } from '@/components/PinGate';
import {
  getTripState, subscribeTrip, startTrip, endTrip, type TripState,
} from '@/lib/trip-session';
import type { RouteSummary } from '@/lib/types';

/**
 * The broadcaster — the screen the driver sees.
 *
 * It holds no tracking state of its own. The trip lives in trip-session, a
 * module that outlives this page, because a trip is a property of the phone and
 * not of whichever screen happens to be open. The driver can switch to Track to
 * glance at his own bus, come back, and find the trip still running.
 *
 * Fixes are buffered and posted in batches, so a tunnel or a dead zone costs
 * nothing — the phone keeps recording and flushes everything when signal
 * returns.
 */

function DrivePageInner() {
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [routeId, setRouteId] = useState('');
  const [t, setT] = useState<TripState>(getTripState);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Subscribe to the trip rather than owning it.
  useEffect(() => {
    setT(getTripState());
    return subscribeTrip(setT);
  }, []);

  useEffect(() => {
    fetch('/api/network')
      .then((r) => r.json())
      .then((j) => {
        setRoutes(j.routes ?? []);
        setRouteId((c) => c || getTripState().routeId || j.routes?.[0]?.id || '');
      })
      .catch(() => setLoadErr('Could not load the route — check your connection.'));
  }, []);

  const active = routes.find((r) => r.id === (t.running ? t.routeId : routeId));

  return (
    <div className="shell" style={{ ['--accent' as string]: active?.color ?? '#38bdf8', maxWidth: 640 }}>
      <TopBar subtitle="Driver" />

      <div className="card enter" data-i="0">
        <div className="card-head">
          <span className="card-title">Broadcast this bus</span>
          {t.running && (
            <span className="badge" data-tone="live" style={{ marginLeft: 'auto' }}>
              <span className="rec-dot" style={{ background: 'var(--live)' }} />on air
            </span>
          )}
        </div>

        <div className="card-body" style={{ display: 'grid', gap: 16 }}>
          <div className="field">
            <span className="field-label">Route</span>
            <select
              className="input" value={t.running ? t.routeId : routeId} disabled={t.running}
              onChange={(e) => setRouteId(e.target.value)}
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>{r.code} · {r.name}</option>
              ))}
            </select>
          </div>

          <div className="ctl-row">
            {!t.running ? (
              <button
                className="btn" data-primary="true"
                onClick={() => void startTrip(routeId)}
                disabled={!routeId}
              >
                ● Start trip
              </button>
            ) : (
              <button className="btn" data-danger="true" onClick={() => void endTrip()}>
                ■ End trip
              </button>
            )}
            <span style={{ fontSize: 12, color: 'var(--dimmer)' }}>
              {!t.running ? 'Uses this phone’s GPS'
                : t.background ? 'On air — you can lock the phone'
                : 'On air — keep this screen on'}
            </span>
          </div>

          {/* The instruction differs between the app and a browser, and the
              driver must not have to guess which he is in. Locking the phone
              stops a browser sharing location; it does not stop the app. */}
          {t.running && (
            <div className="note" style={{ borderLeftColor: t.background ? 'var(--good)' : 'var(--warn)' }}>
              {t.background ? (
                <>
                  <strong style={{ color: 'var(--good)' }}>Running in the background.</strong>{' '}
                  Lock the phone and put it away — tracking continues, and it keeps
                  going if you switch screens. It stops when you press End trip, or
                  by itself when the bus reaches the college.
                </>
              ) : (
                <>
                  <strong style={{ color: 'var(--warn)' }}>Keep this screen on.</strong>{' '}
                  In a browser the phone stops sharing location the moment the screen
                  locks. Mount the phone and keep it charging — or install the driver
                  app, which keeps running with the screen off.
                </>
              )}
            </div>
          )}

          {t.arrived && !t.running && (
            <div className="note" style={{ borderLeftColor: 'var(--good)' }}>
              <strong style={{ color: 'var(--good)' }}>Trip finished.</strong>{' '}
              The bus reached the college, so broadcasting stopped by itself.
            </div>
          )}

          {(t.message || loadErr) && <div className="note">{t.message ?? loadErr}</div>}
        </div>

        <div className="stat-grid">
          <div className="stat">
            <div className="stat-k">Fixes</div>
            <div className="stat-v num">{t.captured}</div>
          </div>
          <div className="stat">
            <div className="stat-k">Accepted</div>
            <div className="stat-v num">{t.accepted}</div>
          </div>
          <div className="stat">
            <div className="stat-k">Buffered</div>
            <div className="stat-v num" style={{ color: t.buffered > 20 ? 'var(--warn)' : undefined }}>
              {t.buffered}
            </div>
          </div>
          <div className="stat">
            <div className="stat-k">GPS ±</div>
            <div className="stat-v num">{t.lastAcc == null ? '—' : `${Math.round(t.lastAcc)}`}<small>m</small></div>
          </div>
          <div className="stat">
            <div className="stat-k">Along route</div>
            <div className="stat-v num">{t.distKm == null ? '—' : t.distKm.toFixed(1)}<small>km</small></div>
          </div>
          <div className="stat">
            <div className="stat-k">Next stop</div>
            <div className="stat-v" style={{ fontSize: 13 }}>{t.nextStop ?? '—'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DrivePage() {
  return (
    <PinGate title="Driver">
      <DrivePageInner />
    </PinGate>
  );
}
