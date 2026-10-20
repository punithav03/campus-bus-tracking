'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { RoleGate } from '@/components/RoleGate';
import { DemoRun } from '@/components/DemoRun';
import { haptic } from '@/lib/device';

/**
 * The transport office's screen: every bus, one page.
 *
 * It answers the only question the office actually has at 8am — "is each bus
 * out, and is it late" — before it offers anything else. Detail is one tap
 * away; a dashboard that opens on a wall of numbers makes the reader do the
 * summarising, which is the job the screen was supposed to do.
 */

interface FleetRoute {
  id: string; code: string; name: string; color: string; busNumber?: string | null;
  schedStart: string; lengthM: number; stopCount: number;
  firstStop: string; lastStop: string;
  live: {
    confidence: string; progress: number; delayS: number; replaying?: boolean;
    etaEndS: number | null; endName: string | null; arrivedAt: number | null;
    nextStop: string | null; distAlongM: number;
  } | null;
}

interface Driver { id: string; name: string; phone: string; routeId: string | null }
interface Review { roll: string; name: string; routeId: string | null; pickup: string | null; stop: string | null; note: string }

const fmtDelay = (s: number) => {
  const m = Math.round(Math.abs(s) / 60);
  if (m < 1) return 'on time';
  return `${m} min ${s > 0 ? 'late' : 'early'}`;
};

const clockIn = (s: number) =>
  new Date(Date.now() + s * 1000).toLocaleTimeString('en-IN',
    { hour: '2-digit', minute: '2-digit', hour12: false });

function AdminInner() {
  const [routes, setRoutes] = useState<FleetRoute[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [review, setReview] = useState<Review[]>([]);
  const [noStop, setNoStop] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const get = async (u: string) => {
          const r = await fetch(u, { cache: 'no-store' });
          if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
          // An error page is not an empty fleet: keep the last good numbers.
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        };
        const [n, f] = await Promise.all([get('/api/network'), get('/api/admin/fleet')]);
        if (!alive) return;
        setRoutes(n.routes ?? []);
        setDrivers(f.drivers ?? []);
        setCounts(f.studentsByRoute ?? {});
        setReview(f.review ?? []);
        setNoStop(f.noStopByRoute ?? {});
        setErr(null);
      } catch {
        if (alive) setErr('Could not reach the server.');
      }
    };

    void load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const running = routes.filter((r) => r.live).length;
  const students = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="shell" style={{ maxWidth: 720 }}>
      <TopBar subtitle="Transport office" />

      <div className="adm-summary enter" data-i="0">
        <div className="adm-sum">
          <div className="adm-sum-v num">{running}<span className="adm-sum-of">/{routes.length}</span></div>
          <div className="adm-sum-k">Buses running</div>
        </div>
        <div className="adm-sum">
          <div className="adm-sum-v num">{students}</div>
          <div className="adm-sum-k">Students</div>
        </div>
        <div className="adm-sum">
          <div className="adm-sum-v num">{drivers.length}</div>
          <div className="adm-sum-k">Drivers</div>
        </div>
      </div>

      <div className="adm-list">
        {routes.map((r, i) => {
          const driver = drivers.find((d) => d.routeId === r.id);
          const live = r.live;
          return (
            <Link
              key={r.id}
              href={`/track?route=${r.id}`}
              prefetch={false}
              className="card adm-card enter"
              data-i={i + 1}
              style={{ ['--accent' as string]: r.color, textDecoration: 'none', display: 'block' }}
              onClick={() => haptic('tick')}
            >
              <div className="adm-head">
                <span className="ti-badge" style={{ background: r.color }}>{r.code}</span>
                <div className="ti-route-text">
                  <div className="ti-route-name">{r.name}</div>
                  <div className="ti-route-sub">
                    {r.busNumber ? `${r.busNumber} · ` : ''}{r.stopCount} stops · {(r.lengthM / 1000).toFixed(1)} km · starts {r.schedStart}
                  </div>
                </div>
                <span className="ti-state" style={{ position: 'static' }} data-live={!!live}>
                  <span className="ti-state-dot" />
                  {live ? 'LIVE' : 'Idle'}
                </span>
              </div>

              {live ? (
                <>
                  <div className="adm-prog">
                    <div className="adm-prog-fill"
                         style={{ width: `${Math.round(live.progress * 100)}%`, background: r.color }} />
                  </div>
                  {/* The arrival time first, because it is the only line on
                      this card anyone acts on. */}
                  <div className="adm-eta">
                    {live.arrivedAt ? (
                      <span className="adm-eta-done">
                        Reached {live.endName ?? 'the end'} at{' '}
                        <strong>{new Date(live.arrivedAt).toLocaleTimeString('en-IN',
                          { hour: '2-digit', minute: '2-digit', hour12: false })}</strong>
                      </span>
                    ) : live.etaEndS != null ? (
                      <>
                        <span className="adm-eta-n num">{Math.max(0, Math.round(live.etaEndS / 60))}</span>
                        <span className="adm-eta-u">
                          min to {live.endName ?? 'the end'} · arriving{' '}
                          <strong className="num">{clockIn(live.etaEndS)}</strong>
                        </span>
                      </>
                    ) : (
                      <span className="adm-eta-u">Working out the arrival time…</span>
                    )}
                  </div>
                  <div className="adm-stats">
                    {live.nextStop && <span>Next {live.nextStop}</span>}
                    <span>{(live.distAlongM / 1000).toFixed(1)} of {(r.lengthM / 1000).toFixed(1)} km</span>
                    <span data-late={live.delayS > 120}>{fmtDelay(live.delayS)}</span>
                  </div>
                </>
              ) : (
                <div className="adm-idle">Not broadcasting. {r.firstStop} → {r.lastStop}</div>
              )}

              <div className="adm-foot">
                <span className="adm-driver">
                  {driver ? `${driver.name} · ${driver.phone}` : 'No driver assigned'}
                </span>
                <span className="adm-count">
                  {counts[r.id] ?? 0} students
                  {noStop[r.id] ? <span className="adm-nostop"> · {noStop[r.id]} to pick a stop</span> : null}
                  <span className="adm-go" aria-hidden>›</span>
                </span>
              </div>

              {/* Demo only — remove before this goes to the college. */}
              <DemoRun routeId={r.id} running={!!live?.replaying} />
            </Link>
          );
        })}
      </div>

      {review.length > 0 && (
        <details className="card adm-review">
          <summary>
            <strong>{review.length} students to confirm</strong>
            <span>pickup points the timetable does not list, or spellings read one way</span>
          </summary>
          {routes.filter((r) => review.some((x) => x.routeId === r.id)).map((r) => (
            <div key={r.id} className="adm-review-group">
              <div className="adm-review-route">
                <span className="ti-badge" style={{ background: r.color }}>{r.code}</span> {r.name}
              </div>
              {review.filter((x) => x.routeId === r.id).map((x) => (
                <div key={x.roll} className="adm-review-row">
                  <div><strong>{x.name}</strong> <span className="num">{x.roll}</span></div>
                  <div className="adm-review-note">
                    “{x.pickup}” → {x.stop ? <strong>{x.stop}</strong> : <em>no stop yet</em>}. {x.note}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </details>
      )}

      {err && <div className="note">{err}</div>}

      <Link href="/track" className="btn adm-wide" onClick={() => haptic('tick')}>
        Open the live map
      </Link>
    </div>
  );
}

export default function AdminPage() {
  return (
    <RoleGate allow={['admin']}>
      <AdminInner />
    </RoleGate>
  );
}
