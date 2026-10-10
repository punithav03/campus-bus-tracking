'use client';

import { useEffect, useState } from 'react';
import { haptic } from '@/lib/device';

/**
 * Choosing where you get on.
 *
 * Shown full-screen once, the first time a student signs in, and again from
 * Settings whenever they want to change it. It is the same component both
 * times — a setup step and a settings screen are the same question, and
 * writing it twice is how the two drift apart.
 *
 * Every option carries its own pickup and drop time. A list of village names
 * makes the student do the work of remembering which one is theirs; a list
 * that says "Tiruchanoor · 08:25" answers the question they actually came
 * with.
 */

export interface StopOption {
  id: string; name: string; seq: number; estimated: boolean;
  pickup: string; drop: string;
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

  const load = async () => {
    setLoading(true);
    try {
      const j = await (await fetch('/api/me/stop', { cache: 'no-store' })).json();
      setRoute(j.route ?? null);
      setStops(j.stops ?? []);
      setChosen(j.current ?? null);
      setError(null);
    } catch {
      setError('Could not load the stops. Check your connection.');
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

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
              </span>
              <span className="bp-times num">
                <span>{s.pickup}</span>
                <span className="bp-drop">{s.drop}</span>
              </span>
            </button>
          ))}
      </div>

      {error && <div className="note" style={{ borderLeftColor: 'var(--bad)' }}>{error}</div>}

      <div className="bp-foot">
        {pick && (
          <p className="bp-summary">
            Picked up at <strong>{pick.name}</strong> around <strong>{pick.pickup}</strong>,
            dropped back around <strong>{pick.drop}</strong>.
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
