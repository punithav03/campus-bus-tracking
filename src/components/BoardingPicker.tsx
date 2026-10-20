'use client';

import { useEffect, useRef, useState } from 'react';
import { haptic } from '@/lib/device';
import { getJSON } from '@/lib/api';

/**
 * Choosing where you get on.
 *
 * Shown full-screen once, the first time a student signs in, and again from
 * Settings whenever they want to change it. It is the same component both
 * times — a setup step and a settings screen are the same question, and
 * writing it twice is how the two drift apart.
 *
 * Every option carries its own pickup time. A list of village names
 * makes the student do the work of remembering which one is theirs; a list
 * that says "Tiruchanoor · 08:25" answers the question they actually came
 * with.
 */

export interface StopOption {
  id: string; name: string; seq: number; estimated: boolean;
  /** Students board here, but the office's timetable does not list it. */
  extra?: boolean;
  pickup: string;
}
interface RouteInfo { id: string; code: string; name: string; color: string }

export function BoardingPicker({
  mode,
  onSaved,
  onCancel,
}: {
  /** 'setup' is the unskippable first run; 'settings' can be backed out of. */
  mode: 'setup' | 'settings';
  onSaved: (routeId: string, stopId: string) => void;
  onCancel?: () => void;
}) {
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [stops, setStops] = useState<StopOption[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const have = useRef(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const r = await getJSON<{ route?: RouteInfo | null; stops?: StopOption[]; current?: string | null }>('/api/me/stop');
    if (r.ok) {
      setRoute(r.data.route ?? null);
      setStops(r.data.stops ?? []);
      have.current = !!r.data.stops?.length;
      setChosen((c) => c ?? r.data.current ?? null);
      if (!r.data.stops?.length) setError('No stops are set up for your bus yet. Please contact the transport office.');
    } else if (r.status === 401) {
      window.location.href = '/login';
      return;
    } else {
      // Never a blank list with nothing to tap: say so, and offer a retry.
      setError(r.status === 0
        ? 'Could not load the stops. Check your connection.'
        : 'The server is busy. Please try again.');
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // Came back online, or back to the app after switching away: if the
    // list never arrived, fetch it again without making them tap.
    const again = () => { if (document.visibilityState === 'visible' && !have.current) void load(); };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('online', again); document.removeEventListener('visibilitychange', again); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/me/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stopId: chosen }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j?.error ?? 'Could not save.'); setBusy(false); haptic('alert'); return; }
      haptic('select');
      onSaved(route?.id ?? '', chosen);
    } catch {
      setError('No connection. Try again.');
      setBusy(false);
    }
  }

  const pick = stops.find((s) => s.id === chosen);

  return (
    <div className="bp">
      <header className="bp-head">
        <h1 className="bp-title">
          {mode === 'setup' ? 'Where do you get on?' : 'Change your boarding point'}
        </h1>
        <p className="bp-sub">
          {mode === 'setup'
            ? 'Pick your stop once. We will show the bus arriving at it, every morning.'
            : 'Picked the wrong one? Choose the stop you actually board at.'}
        </p>
      </header>

      {/* Which bus you are on — stated, not offered. The transport office
          assigns the route; this screen only corrects the stop on it. */}
      {route && (
        <div className="bp-route-tag">
          <span className="bp-route-code" style={{ background: route.color }}>{route.code}</span>
          <span className="bp-route-label">{route.name}</span>
        </div>
      )}

      <div className="bp-list" role="radiogroup" aria-label="Your stop">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="sk bp-sk" />)
          : stops.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={chosen === s.id}
              className="bp-stop"
              data-on={chosen === s.id}
              onClick={() => { haptic('tick'); setChosen(s.id); }}
            >
              <span className="bp-dot" aria-hidden />
              <span className="bp-stop-name">
                {s.name}
                {s.estimated && <span className="ti-approx" title="Position is approximate">~</span>}
                {s.extra && <span className="bp-extra" title="Students board here; the bus passes it, but it is not on the office's timetable, so the time is worked out from the stops either side">not on timetable</span>}
              </span>
              <span className="bp-times num">{s.pickup}</span>
            </button>
          ))}
      </div>

      {error && (
        <div className="note" style={{ borderLeftColor: 'var(--bad)' }}>
          {error}
          {!loading && !stops.length && (
            <button className="btn" style={{ marginTop: 10, display: 'flex' }} onClick={() => { haptic('tick'); void load(); }}>
              Try again
            </button>
          )}
        </div>
      )}

      <div className="bp-foot">
        {pick && (
          <p className="bp-summary">
            Picked up at <strong>{pick.name}</strong> around <strong>{pick.pickup}</strong>.
          </p>
        )}
        <div className="bp-actions">
          {mode === 'settings' && onCancel && (
            <button className="btn bp-btn" onClick={() => { haptic('tick'); onCancel(); }}>
              Cancel
            </button>
          )}
          <button
            className="btn bp-btn" data-primary="true"
            onClick={save} disabled={!chosen || busy}
          >
            {busy ? <span className="spin" aria-hidden /> : null}
            {busy ? 'Saving…' : mode === 'setup' ? 'This is my stop' : 'Save'}
          </button>
        </div>
        {mode === 'setup' && (
          <p className="bp-help">You can change this any time in Settings.</p>
        )}
      </div>
    </div>
  );
}
