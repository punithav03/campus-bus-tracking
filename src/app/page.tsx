'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { BusArt } from '@/components/BusArt';
import { haptic } from '@/lib/device';
import { useSession } from '@/lib/useSession';
import { PasswordGate } from '@/components/PasswordGate';
import { BoardingGate } from '@/components/BoardingGate';
import { NotifyCard } from '@/components/NotifyCard';
import { WaitingButton } from '@/components/WaitingButton';

/**
 * Home, for a student.
 *
 * Deliberately not the map. The map answers "where is the bus", which is the
 * interesting question for us and the second question for them. The first is
 * "when does it reach MY stop, and what do I do if it doesn't" — so that is
 * what the screen leads with, and the map is one tap behind a button.
 *
 * Drivers and admins never see this; they are sent to their own screen the
 * moment we know who they are.
 */

interface Transport {
  role: string;
  name?: string;
  route: { id: string; code: string; name: string; color: string;
           startTime: string; stopCount: number; lengthKm: number | null } | null;
  driver: { name: string; phone: string } | null;
  boarding: { id: string; name: string; seq: number; estimated: boolean;
              pickup: string; drop: string } | null;
  live: { confidence: string; progress: number; delayS: number;
          nextStop: string | null; ageS: number; speedMps?: number | null } | null;
  eta: { seconds: number; clock: string; stopsAway: number; passed: boolean } | null;
  message?: string;
}

const fmtMins = (s: number) => {
  const m = Math.round(s / 60);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

function HomeInner() {
  const router = useRouter();
  const { phase, user } = useSession();
  const [t, setT] = useState<Transport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The last position we genuinely saw, kept across a dropout. A blank screen
  // in a dead zone tells a student nothing; "last seen 3 min ago near
  // Tiruchanoor" tells them the bus is coming and roughly from where.
  const [lastSeen, setLastSeen] = useState<{ at: number; near: string } | null>(null);

  // Send everyone to where they belong before anything renders.
  useEffect(() => {
    if (phase === 'out') router.replace('/login');
    else if (phase === 'in' && user?.role === 'driver') router.replace('/drive');
    else if (phase === 'in' && user?.role === 'admin') router.replace('/admin');
  }, [phase, user, router]);

  useEffect(() => {
    if (phase !== 'in' || user?.role !== 'student') return;
    let alive = true;

    const load = async () => {
      try {
        const r = await fetch('/api/me/transport', { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Transport;
        if (!alive) return;
        setT(j);
        setErr(null);
        // The launch screen waits on this. Without it the splash always sat
        // for its full ceiling before lifting, even though the screen it was
        // covering had been ready for a second — and a launch screen that
        // outstays the content is exactly what makes an app feel slow.
        document.documentElement.dataset.ready = '1';
        if (j.live?.nextStop) setLastSeen({ at: Date.now(), near: j.live.nextStop });
      } catch {
        if (alive) setErr('Could not reach the server.');
      }
    };

    void load();
    // Warm the route geometry while they are still reading this screen. It is
    // the biggest thing the map page has to fetch, and pulling it now means
    // "Track bus on map" opens on a drawn route instead of an empty one.
    void fetch('/api/me/transport', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => (j?.route?.id
        ? fetch(`/api/route/${j.route.id}`, { cache: 'no-store' })
        : null))
      .catch(() => { /* the map page retries on its own */ });
    // Slow while idle, because this screen is open at a bus stop on mobile
    // data. The map page polls hard; this one only needs to stay honest.
    const id = setInterval(load, 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [phase, user]);

  if (phase === 'checking' || (phase === 'in' && user?.role !== 'student')) {
    return (
      <div className="shell" style={{ maxWidth: 560 }}>
        <TopBar subtitle="Transport" />
        <div className="ti-skeleton" aria-hidden>
          <div className="sk sk-hero" /><div className="sk sk-row" /><div className="sk sk-row" />
        </div>
      </div>
    );
  }

  const accent = t?.route?.color ?? '#f97316';
  const live = t?.live;
  const eta = t?.eta;

  return (
    <div className="shell" style={{ ['--accent' as string]: accent, maxWidth: 560 }}>
      <TopBar subtitle="Transport" />

      {/* ---------------------------------------------------------- hero */}
      <section className="ti-hero enter" data-i="0">
        {/* Animated only when a bus is genuinely reporting. A scrolling road
            under "not running" is the app telling a cheerful lie. */}
        <div className="ti-hero-art" aria-hidden>
          <BusArt
            moving={!!live && live.confidence !== 'stale'}
            speedMps={live?.speedMps ?? null}
          />
        </div>

        <div className="ti-hero-body">
          {live && eta && !eta.passed && eta.clock ? (
            <>
              <div className="ti-kicker">Your bus arrives in</div>
              <div className="ti-big num">
                {fmtMins(eta.seconds)}
                <span className="ti-big-at">· {eta.clock}</span>
              </div>
              <div className="ti-meta">
                {eta.stopsAway > 0 ? `${eta.stopsAway} stop${eta.stopsAway > 1 ? 's' : ''} away` : 'next stop'}
                {/* Under a minute is not news. Saying "running now late" because
                    the bus is one second behind the timetable makes the whole
                    screen look like it is guessing. */}
                {Math.abs(live.delayS) >= 60
                  ? ` · running ${fmtMins(Math.abs(live.delayS))} ${live.delayS > 0 ? 'late' : 'early'}`
                  : ' · on time'}
              </div>
            </>
          ) : live && eta?.passed ? (
            <>
              <div className="ti-kicker">Your stop</div>
              <div className="ti-big ti-big-sm">Bus already passed</div>
              <div className="ti-meta">Now heading to {live.nextStop ?? 'the campus'}</div>
            </>
          ) : live ? (
            <>
              <div className="ti-kicker">Bus is running</div>
              <div className="ti-big ti-big-sm">On the way</div>
              <div className="ti-meta">Next stop {live.nextStop ?? '—'}</div>
            </>
          ) : (
            <>
              <div className="ti-kicker">Scheduled pickup</div>
              <div className="ti-big num">{t?.boarding?.pickup ?? '—'}</div>
              <div className="ti-meta">
                {t?.route ? `Bus not running yet · starts ${t.route.startTime}` : 'Loading your route…'}
              </div>
            </>
          )}
        </div>

        <span className="ti-state" data-live={!!live}>
          <span className="ti-state-dot" />
          {live ? 'LIVE' : 'Not running'}
        </span>
      </section>

      {/* ------------------------------------------------- boarding point */}
      <section className="card enter" data-i="1">
        <div className="ti-row">
          <span className="ti-row-k">Your boarding point</span>
          <span className="ti-row-v">
            {t?.boarding?.name ?? '—'}
            {t?.boarding?.estimated && <span className="ti-approx" title="Position is approximate">~</span>}
          </span>
        </div>
        <div className="ti-split">
          <div className="ti-row ti-row-half">
            <span className="ti-row-k">Pickup</span>
            <span className="ti-row-v num">{t?.boarding?.pickup ?? '—'}</span>
          </div>
          <div className="ti-row ti-row-half">
            <span className="ti-row-k">Drop</span>
            <span className="ti-row-v num">{t?.boarding?.drop ?? '—'}</span>
          </div>
        </div>

        <WaitingButton stopName={t?.boarding?.name ?? null} />

        <Link href="/track" className="ti-track" onClick={() => haptic('select')}>
          <span className="ti-track-ic" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M12 2.6c-3.5 0-6.3 2.8-6.3 6.3 0 4.7 6.3 12.5 6.3 12.5s6.3-7.8 6.3-12.5c0-3.5-2.8-6.3-6.3-6.3z"
                    fill="none" stroke="currentColor" strokeWidth="1.8" />
              <circle cx="12" cy="8.9" r="2.4" fill="currentColor" />
            </svg>
          </span>
          Track bus on map
          <span className="ti-track-go" aria-hidden>›</span>
        </Link>
      </section>

      {/* --------------------------------------------------------- driver */}
      <section className="card enter" data-i="2">
        <div className="card-head"><span className="card-title">Your driver</span></div>
        <div className="ti-driver">
          <div className="ti-avatar" style={{ background: accent }}>
            {(t?.driver?.name ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="ti-driver-text">
            <div className="ti-driver-name">{t?.driver?.name ?? '—'}</div>
            <div className="ti-driver-sub">{t?.route?.name ?? 'Route'}</div>
          </div>
          {t?.driver?.phone && (
            <>
              <a className="ti-icon-btn" href={`tel:${t.driver.phone}`} aria-label={`Call ${t.driver.name}`}
                 onClick={() => haptic('select')}>
                <svg viewBox="0 0 24 24" width="19" height="19">
                  <path d="M6.6 3.5h3l1.5 3.8-2 1.4a12 12 0 0 0 5.2 5.2l1.4-2 3.8 1.5v3a1.6 1.6 0 0 1-1.8 1.6C11.2 17.4 6.6 12.8 5 5.3A1.6 1.6 0 0 1 6.6 3.5z"
                        fill="currentColor" />
                </svg>
              </a>
              <a className="ti-icon-btn" href={`sms:${t.driver.phone}`} aria-label={`Message ${t.driver.name}`}
                 onClick={() => haptic('tick')}>
                <svg viewBox="0 0 24 24" width="19" height="19">
                  <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3.2V17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"
                        fill="currentColor" />
                </svg>
              </a>
            </>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------- route card */}
      <section className="card enter" data-i="3">
        <div className="card-head"><span className="card-title">Route</span></div>
        <div className="ti-route">
          <span className="ti-badge" style={{ background: accent }}>{t?.route?.code ?? '–'}</span>
          <div className="ti-route-text">
            <div className="ti-route-name">{t?.route?.name ?? '—'}</div>
            <div className="ti-route-sub">
              {t?.route ? `${t.route.stopCount} stops · ${t.route.lengthKm ?? '—'} km · starts ${t.route.startTime}` : ''}
            </div>
          </div>
        </div>
      </section>

      {/* Offline, or the bus went quiet. Either way the student deserves the
          last thing we knew rather than an empty screen. */}
      {!t?.live && lastSeen && Date.now() - lastSeen.at < 30 * 60_000 && (
        <div className="lk enter" data-i="4">
          <span className="lk-dot" aria-hidden />
          <span className="lk-text">
            No signal from the bus right now. Last seen{' '}
            <strong>{Math.max(1, Math.round((Date.now() - lastSeen.at) / 60000))} min ago</strong>
            {' '}heading for <strong>{lastSeen.near}</strong>.
          </span>
        </div>
      )}

      <NotifyCard />

      {(err || t?.message) && <div className="note enter" data-i="5">{t?.message ?? err}</div>}

      <p className="ti-foot">Times are scheduled estimates until the bus is running.</p>
    </div>
  );
}

export default function HomePage() {
  // Password first, then the boarding point: no point asking where they get
  // on while the account is still using a password anyone could guess.
  return (
    <PasswordGate>
      <BoardingGate>
        <HomeInner />
      </BoardingGate>
    </PasswordGate>
  );
}
