'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { StripMap } from '@/components/StripMap';
import { Compare, type Sample } from '@/components/Compare';
import { BottomSheet, useMediaQuery } from '@/components/BottomSheet';
import type { MapRoute } from '@/components/MapView';
import {
  CONFIDENCE_COLOR, CONFIDENCE_LABEL, clockAt, fmtAge, fmtClock, fmtDelay, fmtEta,
} from '@/lib/format';
import { useAnimatedNumber } from '@/lib/useAnimatedNumber';
import { haptic, setBadge, share } from '@/lib/device';
import type { Campus, RouteSummary, StateView } from '@/lib/types';

const MapView = dynamic(() => import('@/components/MapView').then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="map-wrap"><div className="map-fallback">loading map…</div></div>,
});

interface LiveRoute extends RouteSummary {
  live: { confidence: string; progress: number; delayS: number; replaying: boolean } | null;
}

const POLL_MS = 2000;
const HISTORY_MAX = 60;

export default function TrackPage() {
  const [campus, setCampus] = useState<Campus | null>(null);
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [geom, setGeom] = useState<MapRoute | null>(null);
  const [state, setState] = useState<(StateView & { replaying?: boolean }) | null>(null);
  const [myStopId, setMyStopId] = useState<string | null>(null);
  const [walkMin, setWalkMin] = useState(5);
  const [history, setHistory] = useState<Sample[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const historyKey = useRef<string>('');

  // Below this width the map takes the whole screen and the content rides over
  // it in a draggable sheet — the layout every transit and ride app uses.
  const mobile = useMediaQuery('(max-width: 939px)');

  // ---- preferences ---------------------------------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem('campusbus.prefs');
      if (raw) {
        const p = JSON.parse(raw);
        if (p.routeId) setRouteId(p.routeId);
        if (p.myStopId) setMyStopId(p.myStopId);
        if (p.walkMin) setWalkMin(p.walkMin);
      }
    } catch { /* first visit */ }
  }, []);

  useEffect(() => {
    if (!routeId) return;
    localStorage.setItem('campusbus.prefs', JSON.stringify({ routeId, myStopId, walkMin }));
  }, [routeId, myStopId, walkMin]);

  // ---- network -------------------------------------------------------------
  const loadNetwork = useCallback(async () => {
    try {
      const r = await fetch('/api/network', { cache: 'no-store' });
      const j = await r.json();
      if (j.error) { setErr(j.error); return; }
      setCampus(j.campus);
      setRoutes(j.routes);
      setRouteId((cur) => cur ?? j.routes[0]?.id ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { void loadNetwork(); }, [loadNetwork]);
  useEffect(() => {
    const t = setInterval(loadNetwork, 15000);
    return () => clearInterval(t);
  }, [loadNetwork]);

  // ---- route geometry ------------------------------------------------------
  useEffect(() => {
    if (!routeId) return;
    let dead = false;
    (async () => {
      // no-store, not just a no-cache header: the header only helps once the
      // browser has thrown away the copy it already holds. This bypasses the
      // HTTP cache outright, so a re-seeded route shows up on the next load
      // rather than whenever the old entry happens to expire.
      const r = await fetch(`/api/route/${routeId}`, { cache: 'no-store' });
      if (!r.ok || dead) return;
      const j = await r.json();
      setGeom({
        id: j.id,
        color: j.color,
        shape: j.shape,
        stops: j.stops.map(
          (s: { id: string; name: string; lat: number; lng: number; estimated?: boolean }) => ({
            id: s.id, name: s.name, lat: s.lat, lng: s.lng, estimated: s.estimated,
          }),
        ),
      });
      // Default to the stop nearest the start of the line the first time.
      setMyStopId((cur) =>
        cur && j.stops.some((s: { id: string }) => s.id === cur) ? cur : j.stops[0]?.id ?? null,
      );
    })();
    return () => { dead = true; };
  }, [routeId]);

  // ---- live state ----------------------------------------------------------
  useEffect(() => {
    if (!routeId) return;
    let dead = false;

    const tick = async () => {
      try {
        const r = await fetch(`/api/state?route=${routeId}`, { cache: 'no-store' });
        const j = await r.json();
        if (dead || j.error) return;
        setState(j);
      } catch { /* transient — keep the last good state on screen */ }
    };

    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => { dead = true; clearInterval(t); };
  }, [routeId]);

  const myStop = useMemo(
    () => state?.stops.find((s) => s.id === myStopId) ?? null,
    [state, myStopId],
  );

  // Reset the comparison chart whenever the question changes.
  useEffect(() => {
    const key = `${routeId}:${myStopId}:${state?.trip?.id ?? ''}`;
    if (key !== historyKey.current) {
      historyKey.current = key;
      setHistory([]);
    }
  }, [routeId, myStopId, state?.trip?.id]);

  useEffect(() => {
    if (!myStop || !state?.trip) return;
    setHistory((h) =>
      [...h, { profile: myStop.etaS, naive: myStop.etaNaiveS }].slice(-HISTORY_MAX),
    );
  }, [myStop?.etaS, myStop?.etaNaiveS, state?.trip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const route = state?.route;
  const color = route?.color ?? '#f97316';
  const trip = state?.trip ?? null;
  const conf = trip?.confidence ?? 'stale';

  const leaveNow =
    myStop?.etaS != null && !myStop.passed && myStop.etaS <= walkMin * 60 + 90;

  // The headline number rolls to its new value instead of snapping — a jump
  // reads as a glitch, a roll reads as a countdown.
  const easedEta = useAnimatedNumber(myStop && !myStop.passed ? myStop.etaS : null);

  // Ring fills as the bus covers the gap between the previous stop and yours.
  const approach = useMemo(() => {
    if (!trip || !myStop || myStop.passed || !state) return 0;
    const i = state.stops.findIndex((s) => s.id === myStop.id);
    const prev = i > 0 ? state.stops[i - 1].distAlongM : 0;
    const span = myStop.distAlongM - prev || 1;
    return Math.max(0, Math.min(1, (trip.distAlongM - prev) / span));
  }, [trip, myStop, state]);

  // "3 stops away" lands harder than "9 min" — minutes are abstract, stops are
  // countable. Transit apps show both for exactly this reason.
  const stopsAway = useMemo(() => {
    if (!trip || !myStop || myStop.passed || !state) return null;
    return state.stops.filter((s) => !s.passed && s.distAlongM <= myStop.distAlongM).length;
  }, [trip, myStop, state]);

  // The last stop is the college. When it has an arrival event the run is
  // finished, and that time is what the page should lead with.
  const finalStop = state?.stops[state.stops.length - 1] ?? null;
  const arrivedAtCampus = finalStop?.arrivedAt ?? null;

  // Minutes on the home-screen icon, so you can check without opening anything.
  useEffect(() => {
    setBadge(myStop && !myStop.passed && myStop.etaS != null ? myStop.etaS / 60 : null);
  }, [myStop?.etaS, myStop?.passed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Buzz once when it becomes time to walk — the whole point is that you do not
  // have to be looking at the screen.
  const buzzed = useRef<string | null>(null);
  useEffect(() => {
    const key = `${trip?.id ?? ''}:${myStopId ?? ''}`;
    if (leaveNow && buzzed.current !== key) { buzzed.current = key; haptic('alert'); }
    if (!leaveNow && buzzed.current === key) buzzed.current = null;
  }, [leaveNow, trip?.id, myStopId]);

  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const onShare = async () => {
    haptic('select');
    const eta = myStop?.etaS != null ? `${Math.round(myStop.etaS / 60)} min away` : 'live tracking';
    const res = await share(
      'Campus Bus — SVPCET',
      `Bus to ${myStop?.name ?? 'campus'}, ${eta}.`,
    );
    setShareMsg(res === 'copied' ? 'Link copied' : res === 'failed' ? 'Could not share' : null);
    setTimeout(() => setShareMsg(null), 2200);
  };

  if (err) {
    return (
      <div className="shell">
        <TopBar />
        <div className="card"><div className="empty">
          <strong style={{ color: 'var(--text)' }}>{err}</strong>
          <br />Run <span className="mono">npm run seed</span> to build the route network.
        </div></div>
      </div>
    );
  }

  return (
    <div className="shell" data-mobile={mobile} style={{ ['--accent' as string]: color }}>
      <TopBar subtitle={campus ? `${campus.name} · Puttur` : undefined} />

      {/* ---- route picker ---- */}
      <div className="chips">
        {routes.map((r) => (
          <button
            key={r.id}
            className="chip"
            style={{ ['--c' as string]: r.color }}
            data-on={r.id === routeId}
            onClick={() => setRouteId(r.id)}
          >
            <span className="chip-dot" />
            <span>
              <span className="chip-label">{r.short}</span>
              <span className="chip-meta" style={{ display: 'block' }}>
                {r.firstStop} · {(r.lengthM / 1000).toFixed(0)} km
              </span>
            </span>
            {r.live && <span className="chip-live">LIVE</span>}
          </button>
        ))}
      </div>

      <div className="grid">
        {/* ============ content — a draggable sheet on mobile ============ */}
        <BottomSheet
          enabled={mobile}
          peekLabel={
            trip && myStop && !myStop.passed && myStop.etaS != null ? (
              <>
                <strong className="num">{Math.max(0, Math.round(myStop.etaS / 60))} min</strong>
                <span>to {myStop.name}</span>
              </>
            ) : (
              <span>{trip ? 'Bus has passed your stop' : 'No bus running'}</span>
            )
          }
        >
        <div className="col">
          {/* ---- hero ---- */}
          <div className="hero enter" data-i="0">
            <div className="hero-kicker">
              <span>Route {route?.code ?? '—'}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>{route?.short ?? ''}</span>
              {state?.replaying && <span className="badge" style={{ marginLeft: 4 }}>replay</span>}
            </div>

            <div className="hero-dest" aria-live="polite">
              Bus to <strong>{myStop?.name ?? 'your stop'}</strong>
            </div>

            {trip && myStop && !myStop.passed && myStop.etaS != null ? (
              <>
                <div className="hero-main">
                  <div className="hero-figure">
                    <span className="hero-num num">
                      {easedEta == null ? '—' : Math.max(0, Math.round(easedEta / 60))}
                    </span>
                    <span className="hero-unit">
                      min · arriving {clockAt(state!.now, myStop.etaS)}
                    </span>
                  </div>
                  <ApproachRing progress={approach} />
                </div>
                <div className="hero-range num">
                  {stopsAway != null && (
                    <strong className="hero-stops">
                      {stopsAway <= 1 ? 'Next stop' : `${stopsAway} stops away`}
                    </strong>
                  )}
                  likely {fmtEta(myStop.etaLoS)} – {fmtEta(myStop.etaHiS)}
                  {trip.delayS !== 0 && <> · running {fmtDelay(trip.delayS)}</>}
                </div>
              </>
            ) : trip && arrivedAtCampus ? (
              // Once the bus is at the college, that is the fact worth leading
              // with — the run is over, and the arrival time is what anyone
              // asking about this trip actually wants.
              <>
                <div className="hero-none">Reached {finalStop?.name ?? 'the college'}</div>
                <div className="hero-figure" style={{ marginTop: 4 }}>
                  <span className="hero-num num" style={{ fontSize: 'clamp(44px, 11vw, 62px)' }}>
                    {fmtClock(arrivedAtCampus)}
                  </span>
                </div>
                {myStop?.arrivedAt && (
                  <div className="hero-range">
                    Passed {myStop.name} at{' '}
                    <strong style={{ color: 'var(--text)' }}>{fmtClock(myStop.arrivedAt)}</strong>
                  </div>
                )}
              </>
            ) : trip && myStop?.passed ? (
              <>
                <div className="hero-none">Bus already passed</div>
                {myStop.arrivedAt && (
                  <div className="hero-figure" style={{ marginTop: 4 }}>
                    <span className="hero-num num" style={{ fontSize: 'clamp(44px, 11vw, 62px)' }}>
                      {fmtClock(myStop.arrivedAt)}
                    </span>
                    <span className="hero-unit">at {myStop.name}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="hero-none">Not running right now</div>
            )}

            {trip ? (
              <div
                className="fresh"
                data-c={conf}
                style={{ ['--f' as string]: CONFIDENCE_COLOR[conf] }}
              >
                <span className="fresh-dot" />
                <span>
                  {CONFIDENCE_LABEL[conf]} · {fmtAge(trip.ageS)}
                  {conf === 'estimated' && ' · position estimated'}
                </span>
              </div>
            ) : (
              <div className="fresh" style={{ ['--f' as string]: 'var(--dimmer)' }}>
                <span className="fresh-dot" />
                <span>Scheduled {route?.schedStart ?? '—'} · no live signal</span>
              </div>
            )}

            <button className="hero-share" onClick={onShare} aria-label="Share live tracking link">
              {shareMsg ?? '↗ Share'}
            </button>

            {leaveNow && (
              <div className="leave-now">
                <span className="leave-now-icon">🚶</span>
                <div>
                  <div className="leave-now-title">Leave now</div>
                  <div className="leave-now-sub">
                    {walkMin} min walk · bus arrives in {fmtEta(myStop!.etaS)}
                  </div>
                </div>
              </div>
            )}

            {/* No operator controls here. This page is public: a student can
                neither start nor stop a trip, and a button that always returns
                401 is worse than no button. Replay lives on /drive, behind the
                PIN. The "replay" badge above stays, because a student watching
                a replayed bus deserves to know it is not the real one. */}
          </div>

          {/* ---- my stop ---- */}
          <div className="card enter" data-i="1">
            <div className="card-head"><span className="card-title">Your boarding point</span></div>
            <div className="card-body" style={{ display: 'grid', gap: 14 }}>
              <div className="field">
                <span className="field-label">Stop</span>
                <select
                  className="input"
                  value={myStopId ?? ''}
                  onChange={(e) => { haptic('select'); setMyStopId(e.target.value); }}
                >
                  {state?.stops.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="field-label">Walk to the stop · {walkMin} min</span>
                <input
                  type="range" min={1} max={20} value={walkMin}
                  onChange={(e) => setWalkMin(Number(e.target.value))}
                />
                <span style={{ fontSize: 11.5, color: 'var(--dimmer)' }}>
                  &ldquo;Leave now&rdquo; fires this many minutes before the bus reaches you.
                </span>
              </div>
            </div>
          </div>

          {/* ---- strip map ---- */}
          <div className="card enter" data-i="2">
            <div className="card-head">
              <span className="card-title">Stops</span>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--dimmer)' }}>
                {state?.stops.length ?? 0} stops · {((route?.lengthM ?? 0) / 1000).toFixed(1)} km
              </span>
            </div>
            <StripMap
              stops={state?.stops ?? []}
              color={color}
              myStopId={myStopId}
              onPick={(id) => { haptic('select'); setMyStopId(id); }}
              busDistM={trip?.distAlongM ?? null}
              hasTrip={!!trip}
            />
          </div>

          {mobile && (
            <Compare
              stop={myStop}
              now={state?.now ?? Date.now()}
              color={color}
              history={history}
              accuracy={state?.accuracy ?? []}
            />
          )}
        </div>
        </BottomSheet>

        {/* ================= the map owns the screen ================= */}
        <div className="stage">
          <div className="card enter" data-i="1">
            <div className="card-head">
              <span className="card-title">{route?.name ?? 'Route'}</span>
              {trip && (
                <span className="badge" data-tone={conf === 'live' ? 'live' : conf === 'stale' ? 'bad' : 'warn'}
                      style={{ marginLeft: 'auto' }}>
                  {CONFIDENCE_LABEL[conf]}
                </span>
              )}
            </div>
            <MapView
              route={geom}
              bus={trip ? { lat: trip.lat, lng: trip.lng, bearing: trip.bearing, ghost: conf === 'estimated' } : null}
              myStopId={myStopId}
              campus={campus ? { lat: campus.lat, lng: campus.lng, name: campus.name } : null}
              progress={trip?.progress ?? 0}
            />
            {trip && (
              <div className="stat-grid">
                <div className="stat">
                  <div className="stat-k">Speed</div>
                  <div className="stat-v num">{Math.round(trip.speedMps * 3.6)}<small>km/h</small></div>
                </div>
                <div className="stat">
                  <div className="stat-k">Travelled</div>
                  <div className="stat-v num">{(trip.distAlongM / 1000).toFixed(1)}<small>km</small></div>
                </div>
                <div className="stat">
                  <div className="stat-k">Schedule</div>
                  <div className="stat-v" style={{ color: Math.abs(trip.delayS) < 120 ? 'var(--live)' : 'var(--warn)' }}>
                    {fmtDelay(trip.delayS)}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-k">Fixes kept</div>
                  <div className="stat-v num">
                    {trip.pingCount}
                    <small>/{trip.pingCount + trip.rejectedCount}</small>
                  </div>
                </div>
              </div>
            )}
          </div>

          {!mobile && (
            <Compare
              stop={myStop}
              now={state?.now ?? Date.now()}
              color={color}
              history={history}
              accuracy={state?.accuracy ?? []}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A ring that closes as the bus covers the last leg to your stop. Gives the
 * headline number something to be measured against, so "9 min" is felt as
 * progress rather than read as a fact.
 */
function ApproachRing({ progress }: { progress: number }) {
  const R = 33;
  const C = 2 * Math.PI * R;
  return (
    <div className="ring" title={`${Math.round(progress * 100)}% of the way from the previous stop`}>
      <svg width="78" height="78" viewBox="0 0 78 78" aria-hidden>
        <circle className="ring-track" cx="39" cy="39" r={R} fill="none" strokeWidth="5" />
        <circle
          className="ring-fill" cx="39" cy="39" r={R} fill="none" strokeWidth="5"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.max(0.02, Math.min(1, progress)))}
        />
      </svg>
      <span className="ring-label">on the<br />way</span>
    </div>
  );
}
