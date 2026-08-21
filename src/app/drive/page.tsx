'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { PinGate } from '@/components/PinGate';
import { authFetch } from '@/lib/client-auth';
import type { Ping, RouteSummary } from '@/lib/types';

/**
 * The broadcaster.
 *
 * Deliberately a web page, not an app: the driver opens a link, taps once, and
 * the phone sits plugged in on the dashboard. No install, no store, no APK to
 * sideload. A screen wake-lock keeps it alive while it is mounted and charging.
 *
 * Fixes are buffered and posted in batches, so a tunnel or a dead zone costs
 * nothing — the phone keeps recording and flushes everything when signal returns.
 */

const FLUSH_MS = 10000;

function DrivePageInner() {
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [routeId, setRouteId] = useState('');
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(12);
  const [msg, setMsg] = useState<string | null>(null);

  const [captured, setCaptured] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [lastAcc, setLastAcc] = useState<number | null>(null);
  const [nextStop, setNextStop] = useState<string | null>(null);
  const [distKm, setDistKm] = useState<number | null>(null);

  const queue = useRef<Ping[]>([]);
  const watchId = useRef<number | null>(null);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const flusher = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch('/api/network')
      .then((r) => r.json())
      .then((j) => {
        setRoutes(j.routes ?? []);
        setRouteId((c) => c || j.routes?.[0]?.id || '');
      })
      .catch(() => setMsg('Could not load the route — check your connection.'));
  }, []);

  const flush = useCallback(async () => {
    if (!queue.current.length || !routeId) return;
    const batch = queue.current;
    queue.current = [];
    setBuffered(0);
    try {
      const r = await authFetch('/api/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routeId, pings: batch, source: 'driver' }),
      });
      const j = await r.json();
      setAccepted((a) => a + (j.accepted ?? 0));
      setNextStop(j.nextStop ?? null);
      setDistKm(j.distAlongM != null ? j.distAlongM / 1000 : null);
    } catch {
      // Offline: put them back at the front and try again next tick.
      queue.current = [...batch, ...queue.current];
      setBuffered(queue.current.length);
    }
  }, [routeId]);

  const stop = useCallback(async () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (flusher.current) clearInterval(flusher.current);
    flusher.current = null;
    await flush();
    try { await wakeLock.current?.release(); } catch { /* already gone */ }
    wakeLock.current = null;
    setRunning(false);
    setMsg('Trip ended.');
  }, [flush]);

  const start = useCallback(async () => {
    if (!routeId) return;
    if (!('geolocation' in navigator)) {
      setMsg('This browser has no GPS access.');
      return;
    }
    setMsg(null);
    setCaptured(0); setAccepted(0); setBuffered(0);
    queue.current = [];

    await authFetch('/api/trip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId, action: 'start' }),
    });

    try {
      // Keeps the screen alive while the phone is mounted and charging.
      const anyNav = navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
      if (anyNav.wakeLock) wakeLock.current = await anyNav.wakeLock.request('screen');
    } catch { /* not fatal — the driver can raise the screen timeout instead */ }

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        queue.current.push({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          spd: pos.coords.speed ?? null,
          acc: pos.coords.accuracy ?? null,
          heading: pos.coords.heading ?? null,
          t: pos.timestamp || Date.now(),
        });
        setCaptured((c) => c + 1);
        setBuffered(queue.current.length);
        setLastAcc(pos.coords.accuracy ?? null);
      },
      (e) => setMsg(`GPS error: ${e.message}`),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    );

    flusher.current = setInterval(() => void flush(), FLUSH_MS);
    setRunning(true);
  }, [routeId, flush]);

  useEffect(() => () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    if (flusher.current) clearInterval(flusher.current);
  }, []);

  const replay = async (action: 'replay' | 'stop-replay') => {
    await authFetch('/api/trip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId, action, speed }),
    });
    setMsg(action === 'replay' ? `Replaying at ${speed}×.` : 'Replay stopped.');
  };

  const active = routes.find((r) => r.id === routeId);

  return (
    <div className="shell" style={{ ['--accent' as string]: active?.color ?? '#38bdf8', maxWidth: 640 }}>
      <TopBar subtitle="Driver broadcaster" />

      <div className="card enter" data-i="0">
        <div className="card-head">
          <span className="card-title">Broadcast this bus</span>
          {running && (
            <span className="badge" data-tone="live" style={{ marginLeft: 'auto' }}>
              <span className="rec-dot" style={{ background: 'var(--live)' }} />on air
            </span>
          )}
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 16 }}>
          <div className="field">
            <span className="field-label">Route</span>
            <select
              className="input" value={routeId} disabled={running}
              onChange={(e) => setRouteId(e.target.value)}
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>{r.code} · {r.name}</option>
              ))}
            </select>
          </div>

          <div className="ctl-row">
            {!running ? (
              <button className="btn" data-primary="true" onClick={start} disabled={!routeId}>
                ● Start trip
              </button>
            ) : (
              <button className="btn" data-danger="true" onClick={stop}>■ End trip</button>
            )}
            <span style={{ fontSize: 12, color: 'var(--dimmer)' }}>
              {running ? 'Broadcasting — keep this tab open' : 'Uses this phone’s GPS'}
            </span>
          </div>

          {msg && <div className="note">{msg}</div>}
        </div>

        <div className="stat-grid">
          <div className="stat">
            <div className="stat-k">Fixes</div>
            <div className="stat-v num">{captured}</div>
          </div>
          <div className="stat">
            <div className="stat-k">Accepted</div>
            <div className="stat-v num">{accepted}</div>
          </div>
          <div className="stat">
            <div className="stat-k">Buffered</div>
            <div className="stat-v num" style={{ color: buffered > 20 ? 'var(--warn)' : undefined }}>
              {buffered}
            </div>
          </div>
          <div className="stat">
            <div className="stat-k">GPS ±</div>
            <div className="stat-v num">{lastAcc == null ? '—' : `${Math.round(lastAcc)}`}<small>m</small></div>
          </div>
          <div className="stat">
            <div className="stat-k">Along route</div>
            <div className="stat-v num">{distKm == null ? '—' : distKm.toFixed(1)}<small>km</small></div>
          </div>
          <div className="stat">
            <div className="stat-k">Next stop</div>
            <div className="stat-v" style={{ fontSize: 13 }}>{nextStop ?? '—'}</div>
          </div>
        </div>
      </div>

      <div className="card enter" data-i="1" style={{ marginTop: 18 }}>
        <div className="card-head"><span className="card-title">Test playback</span></div>
        <div className="card-body" style={{ display: 'grid', gap: 14 }}>
          <div className="note">
            Plays back a previously recorded trip, for testing when no bus is running.
          </div>
          <div className="field">
            <span className="field-label">Speed · {speed}×</span>
            <input type="range" min={1} max={40} value={speed}
                   onChange={(e) => setSpeed(Number(e.target.value))} />
          </div>
          <div className="ctl-row">
            <button className="btn" data-primary="true" onClick={() => replay('replay')}>
              ▶ Play
            </button>
            <button className="btn" onClick={() => replay('stop-replay')}>■ Stop</button>
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
