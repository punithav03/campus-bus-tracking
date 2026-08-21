'use client';

import { useEffect, useMemo, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { PinGate, ForgetPin } from '@/components/PinGate';
import { authFetch } from '@/lib/client-auth';
import { fmtAge, fmtClock, fmtDelay } from '@/lib/format';
import type { RouteSummary, StateView } from '@/lib/types';

/**
 * The transport office view.
 *
 * Students are not the only users who matter — a tracker with no institutional
 * value gets switched off. This is the half that answers the questions the
 * office actually has: which bus has gone dark, which route is chronically
 * late, and is the ETA any good.
 */

interface Rec {
  id: string; name: string; startedAt: number;
  fixes: number; markers: number; distanceM: number;
}

interface LiveRoute extends RouteSummary {
  live: { confidence: string; progress: number; delayS: number; replaying: boolean } | null;
}

const MODEL_LABEL: Record<string, string> = {
  profile: 'Route profile · recent pace',
  legacy: 'Route profile · whole-trip pace',
  naive: 'Naive distance ÷ speed',
};

const MODEL_NOTE: Record<string, string> = {
  profile: 'judges speed from the last few minutes',
  legacy: 'judges speed from the whole trip so far',
  naive: 'what most trackers ship',
};

function AdminPageInner() {
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [state, setState] = useState<StateView | null>(null);
  const [recordings, setRecordings] = useState<Rec[]>([]);

  useEffect(() => {
    const tick = async () => {
      const j = await fetch('/api/network').then((r) => r.json()).catch(() => null);
      if (j?.routes) {
        setRoutes(j.routes);
        setRouteId((c) => c ?? j.routes[0]?.id ?? null);
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!routeId) return;
    const tick = async () => {
      const j = await fetch(`/api/state?route=${routeId}`).then((r) => r.json()).catch(() => null);
      if (j && !j.error) setState(j);
    };
    void tick();
    const t = setInterval(tick, 2500);
    return () => clearInterval(t);
  }, [routeId]);

  const loadRecordings = async () => {
    const j = await authFetch('/api/recording', { cache: 'no-store' })
      .then((r) => r.json()).catch(() => null);
    if (j?.recordings) setRecordings(j.recordings);
  };
  useEffect(() => { void loadRecordings(); }, []);

  const download = async (id: string) => {
    const r = await authFetch(`/api/recording/${id}`);
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const dark = routes.filter((r) => !r.live);
  const trip = state?.trip ?? null;
  const color = state?.route.color ?? '#38bdf8';

  const served = useMemo(
    () => (state?.events ?? []).slice().sort((a, b) => b.arrivedAt - a.arrivedAt),
    [state],
  );

  return (
    <div className="shell" style={{ ['--accent' as string]: color }}>
      <TopBar subtitle="Transport office" />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <ForgetPin />
      </div>

      {/* ---- fleet ---- */}
      <div className="card enter" data-i="0">
        <div className="card-head">
          <span className="card-title">Fleet</span>
          <span style={{ marginLeft: 'auto' }}>
            {dark.length > 0 ? (
              <span className="badge" data-tone="warn">{dark.length} not reporting</span>
            ) : (
              <span className="badge" data-tone="live">all reporting</span>
            )}
          </span>
        </div>
        <div>
          {routes.map((r) => (
            <button
              key={r.id}
              onClick={() => setRouteId(r.id)}
              className="fleet-row"
              data-on={r.id === routeId}
            >
              <span className="fleet-dot" style={{ background: r.color }} />
              <span className="fleet-name">
                <span className="fleet-title">{r.short}</span>
                <span className="fleet-sub">{r.firstStop} → {r.lastStop}</span>
              </span>

              <span className="fleet-bar">
                <span
                  style={{
                    width: `${Math.round((r.live?.progress ?? 0) * 100)}%`,
                    background: r.color,
                  }}
                />
              </span>

              <span className="fleet-delay num">{r.live ? fmtDelay(r.live.delayS) : '—'}</span>

              <span className="fleet-state">
                {r.live ? (
                  <span className="badge" data-tone={r.live.confidence === 'live' ? 'live' : 'warn'}>
                    {r.live.replaying ? 'replay' : r.live.confidence}
                  </span>
                ) : (
                  <span className="badge">dark</span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ---- recordings uploaded from the bus ---- */}
      <div className="card enter" data-i="1" style={{ marginTop: 18 }}>
        <div className="card-head">
          <span className="card-title">Recorded rides</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="badge">{recordings.length}</span>
            <button className="btn" onClick={loadRecordings}
                    style={{ padding: '5px 10px', fontSize: 11.5 }}>
              Refresh
            </button>
          </span>
        </div>
        {recordings.length === 0 ? (
          <div className="empty">
            Nothing uploaded yet.<br />
            Whoever rides the bus records on <span className="mono">/record</span> and taps Upload.
          </div>
        ) : (
          <>
            {recordings.map((r) => (
              <div key={r.id} className="log-row">
                <span className="log-name">
                  {r.name}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--dimmer)' }}>
                    {(r.distanceM / 1000).toFixed(1)} km · {r.fixes} fixes
                    {r.markers > 0 && ` · ${r.markers} marked`}
                  </span>
                </span>
                <span className="num" style={{ fontSize: 11.5, color: 'var(--dimmer)' }}>
                  {r.startedAt ? new Date(r.startedAt).toLocaleDateString() : ''}
                </span>
                {/* A plain <a download> cannot carry the PIN header, so the
                    file is fetched and handed to the browser as a blob. */}
                <button className="btn" onClick={() => download(r.id)}
                        style={{ padding: '6px 11px', fontSize: 12 }}>
                  ↓ Download
                </button>
              </div>
            ))}
            <div className="card-body">
              <div className="note">
                Download a ride, then on the machine with the project run{' '}
                <span className="mono" style={{ color: 'var(--text)' }}>
                  npm run import-trace -- &lt;file&gt; --id route-1 --name &quot;Nagalapuram — Campus&quot;
                </span>{' '}
                to replace the modelled route with the real one.
                <br /><br />
                <strong style={{ color: 'var(--warn)' }}>Download promptly.</strong> On free
                hosting the server&apos;s disk is wiped on every redeploy, so uploads are a
                handover point, not storage.
              </div>
            </div>
          </>
        )}
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <div style={{ display: 'grid', gap: 18 }}>
          {/* ---- ETA accuracy ---- */}
          <div className="card">
            <div className="card-head"><span className="card-title">ETA accuracy · this trip</span></div>
            <div className="card-body">
              {state?.accuracy.some((a) => a.n > 0) ? (
                <div className="cmp">
                  {state.accuracy.map((a) => (
                    <div key={a.model} className="cmp-row" data-hero={a.model === 'profile'}
                         data-weak={a.model === 'naive'}>
                      <div className="cmp-label">
                        {MODEL_LABEL[a.model] ?? a.model}
                        <small>{MODEL_NOTE[a.model]} · {a.n} scored</small>
                      </div>
                      <div className="cmp-val num">{a.maeS}<span style={{ fontSize: 13 }}>s</span></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty" style={{ padding: '24px 0' }}>
                  No scored predictions yet.<br />
                  Errors appear once the bus reaches a stop it had an ETA for.
                </div>
              )}
              <div className="note" style={{ marginTop: 12 }}>
                Mean absolute error, in seconds, over predictions made 1–20 minutes
                ahead. Every ETA is recorded when made and scored when the bus
                actually arrives.
              </div>
            </div>
          </div>

          {/* ---- ingest health ---- */}
          <div className="card">
            <div className="card-head"><span className="card-title">Signal health</span></div>
            {trip ? (
              <div className="stat-grid">
                <div className="stat">
                  <div className="stat-k">Last fix</div>
                  <div className="stat-v" style={{ fontSize: 15 }}>{fmtAge(trip.ageS)}</div>
                </div>
                <div className="stat">
                  <div className="stat-k">Source</div>
                  <div className="stat-v" style={{ fontSize: 15 }}>{trip.source}</div>
                </div>
                <div className="stat">
                  <div className="stat-k">Accepted</div>
                  <div className="stat-v num">{trip.pingCount}</div>
                </div>
                <div className="stat">
                  <div className="stat-k">Rejected</div>
                  <div className="stat-v num" style={{ color: trip.rejectedCount ? 'var(--warn)' : undefined }}>
                    {trip.rejectedCount}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-k">Pace now</div>
                  <div className="stat-v num" style={{ color: trip.pace > 1.15 ? 'var(--warn)' : 'var(--live)' }}>
                    {trip.pace.toFixed(2)}<small>×</small>
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-k">Pace from</div>
                  <div className="stat-v" style={{ fontSize: 14 }}>
                    {trip.paceBasis === 'recent' ? 'last few min' : 'whole trip'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty">This route is not reporting.</div>
            )}
          </div>
        </div>

        {/* ---- stop log ---- */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">Stop log · scheduled vs actual</span>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--dimmer)' }}>
              {served.length} recorded
            </span>
          </div>
          {served.length ? (
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
              {served.map((e) => {
                const stop = state?.stops.find((s) => s.seq === e.seq);
                const late = e.delayS > 120;
                const early = e.delayS < -120;
                return (
                  <div key={e.stopId} className="log-row">
                    <span className="log-name">{stop?.name ?? e.stopId}</span>
                    <span className="num" style={{ color: 'var(--dimmer)' }}>
                      {stop ? fmtClock(state!.trip!.startedAt + stop.schedOffsetS * 1000) : '—'}
                    </span>
                    <span className="num">{fmtClock(e.arrivedAt)}</span>
                    <span className="num" style={{
                      color: late ? 'var(--warn)' : early ? 'var(--dim)' : 'var(--live)',
                      fontSize: 12,
                    }}>
                      {fmtDelay(e.delayS)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty">
              No stops served yet on this trip.<br />
              Arrivals are detected by geofence plus a near-zero speed reading.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <PinGate title="Transport office">
      <AdminPageInner />
    </PinGate>
  );
}
