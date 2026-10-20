'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { RoleGate } from '@/components/RoleGate';
import { Confirm } from '@/components/Confirm';
import { WaitingPanel } from '@/components/WaitingPanel';
import { KeepAliveCard } from '@/components/KeepAliveCard';
import { TripSummary, type Summary } from '@/components/TripSummary';
import {
  getTripState, subscribeTrip, startTrip, endTrip, resumeTripIfRunning, type TripState,
} from '@/lib/trip-session';
import { useSession } from '@/lib/useSession';
import { haptic } from '@/lib/device';
import { getJSON } from '@/lib/api';
import { fmtGap } from '@/lib/format';
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
  const [now, setNow] = useState(() => Date.now());

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

  // "Last sent 4 s ago" has to count up on its own. Without a clock of its
  // own this screen only redraws when a batch lands, which is precisely the
  // event that stops happening when the bus goes dark — so the number would
  // freeze at a reassuring value exactly when it matters.
  useEffect(() => {
    if (!t.running) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [t.running]);

  // Keeps asking until it gets an answer. Asked once, a single failed request
  // left the card on "Loading…" for the whole morning.
  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const r = await getJSON<{ routes?: RouteSummary[] }>('/api/network');
      if (dead) return;
      if (r.ok) { setRoute(r.data.routes?.[0] ?? null); setLoadErr(null); return; }
      if (r.status === 401) { location.href = '/login'; return; }
      setLoadErr('Could not load your route — check your connection. Retrying…');
      timer = setTimeout(load, 10_000);
    };
    void load();
    return () => { dead = true; if (timer) clearTimeout(timer); };
  }, []);

  const routeId = route?.id ?? user?.routeId ?? '';
  const accent = route?.color ?? '#38bdf8';

  // Seconds since the server last ACCEPTED a batch. Before the first one
  // lands, measure from the moment he pressed Start — otherwise a trip that
  // never managed to upload anything at all would show the friendliest
  // possible dash.
  const silentS = t.running
    ? Math.round((now - (t.lastSentAt ?? t.startedAt ?? now)) / 1000)
    : null;
  // Two flush intervals plus slack. Below this a gap is a dropped batch;
  // above it, something is wrong and he needs to know while he can still act.
  const dark = silentS != null && silentS > 70;

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
                {/* Which stack the uploads are using. Android throttles anything
                    the page sends itself once backgrounded, so "native" is the
                    proof that the five-minute blackout cannot happen — and the
                    only way to confirm it without a cable and a log viewer. */}
                {t.via && (
                  <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--dim)' }}>
                    Uploading over the {t.via === 'native' ? 'app' : 'browser'} connection
                    {t.via === 'web' && ' — background uploads may stall'}
                  </div>
                )}
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

        {/* The failure that used to be invisible.
            Fixes kept piling up, every counter looked healthy, and nothing
            was reaching the server — so the driver had no way to know he had
            been off the air for ten minutes. He can act on this: step outside
            the dead zone, or check the phone settings the setup card covers. */}
        {dark && (
          <div className="note" style={{ margin: '0 17px 17px', borderLeftColor: 'var(--bad)' }}>
            <strong style={{ color: 'var(--bad)' }}>
              Nothing has reached the server for {fmtGap(silentS!)}.
            </strong>{' '}
            Students cannot see the bus right now. The phone is still recording
            — {t.buffered} fix{t.buffered === 1 ? '' : 'es'} are held and will be
            sent as soon as there is signal. If this does not clear in a minute,
            check that the app is allowed to run in the background.
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
          {/* The only stat that proves the bus is on air. Every other number
              here stayed healthy right through a ten-minute blackout. */}
          <div className="stat">
            <div className="stat-k">Last sent</div>
            <div className="stat-v num"
                 style={{ color: !t.running ? undefined : dark ? 'var(--bad)' : 'var(--live)' }}>
              {silentS == null ? '—' : fmtGap(silentS)}
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

      {/* Always, not only while this phone is broadcasting. Students tap
          "I'm at the stop" before the bus sets off — that is the whole point
          of it — and during a demo the run is started by the office, so
          gating on this phone's own trip showed the driver nothing. The
          panel hides itself when nobody is waiting. */}
      {/* Below the bus card, not above it: the driver came here to press
          Start, and a setup prompt in front of that button is a prompt he
          learns to dismiss without reading. It disappears for good once he
          has done it. */}
      <KeepAliveCard />

      <WaitingPanel />
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
