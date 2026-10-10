'use client';

import { useEffect, useState } from 'react';

/**
 * Who is standing at which stop, on the driver's screen.
 *
 * Counts, never names. He needs to know whether to pull in, not who is
 * there — and a list of student names on a screen in a bus is surveillance
 * nobody asked for.
 *
 * Hidden entirely when nobody has tapped. An empty panel every morning would
 * train him to stop reading the one morning it matters.
 */
interface Stop { id: string; name: string; seq: number; count: number }

export function WaitingPanel() {
  const [stops, setStops] = useState<Stop[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await (await fetch('/api/driver/waiting', { cache: 'no-store' })).json();
        if (!alive) return;
        setStops(j.stops ?? []);
        setTotal(j.total ?? 0);
      } catch { /* next tick */ }
    };
    void load();
    const id = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!total) return null;

  return (
    <section className="card enter wp" data-i="1" style={{ marginTop: 13 }}>
      <div className="card-head">
        <span className="card-title">Waiting for you</span>
        <span className="badge" data-tone="live" style={{ marginLeft: 'auto' }}>{total}</span>
      </div>
      <div className="wp-list">
        {stops.map((s) => (
          <div key={s.id} className="wp-row">
            <span className="wp-n num">{s.count}</span>
            <span className="wp-name">{s.name}</span>
          </div>
        ))}
      </div>
      <p className="wp-foot">Students who tapped &ldquo;I&rsquo;m at the stop&rdquo; in the last 45 minutes.</p>
    </section>
  );
}
