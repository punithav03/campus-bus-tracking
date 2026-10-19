import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';

/**
 * The picture on the live notification: the route as a line of stops, the bus
 * on it, the student's stop marked, minutes to go in big type — the strip Uber
 * and Swiggy show in their delivery notifications.
 *
 * Chrome on Android shows it when the card is expanded. It is drawn from the
 * query string only (fractions along the route, a stop name, a number), never
 * from the database, so it needs no sign-in and holds nothing private. iPhones
 * ignore notification images; the text carries everything on its own.
 *
 *   ?p=420        bus position, thousandths of the route
 *   &s=0.150.300  stops, thousandths
 *   &m=700        your stop, thousandths
 *   &n=Srinivasam &e=6 (minutes) &st=live|atstop|passed|arrived &r=Tirupati Bus &c=f97316
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const num = (k: string, d = 0) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) ? Math.max(0, Math.min(1000, v)) : d;
  };
  const p = num('p') / 1000;
  const stops = (q.get('s') ?? '').split('.').filter(Boolean).map(Number).filter(Number.isFinite).slice(0, 40).map((v) => Math.max(0, Math.min(1000, v)) / 1000);
  const mineRaw = q.get('m');
  const mine = mineRaw ? num('m') / 1000 : null;
  const name = (q.get('n') ?? '').slice(0, 28);
  const eta = q.get('e');
  const state = q.get('st') ?? 'live';
  const route = (q.get('r') ?? 'SVPCET Bus').slice(0, 28);
  const color = /^[0-9a-f]{6}$/i.test(q.get('c') ?? '') ? `#${q.get('c')}` : '#f97316';

  const W = 720, H = 240, L = 40, R = 40, Y = 158;
  const x = (f: number) => L + f * (W - L - R);
  const big = state === 'arrived' ? 'Reached'
    : state === 'atstop' ? 'Here'
    : state === 'passed' ? 'Left'
    : eta == null || eta === '' ? '—'
    : Number(eta) <= 0 ? 'Now' : `${eta} min`;
  const small = state === 'arrived' ? 'the college'
    : state === 'atstop' ? `at ${name}`
    : state === 'passed' ? name
    : name ? `to ${name}` : '';

  return new ImageResponse(
    (
      <div style={{
        width: W, height: H, display: 'flex', position: 'relative',
        background: 'linear-gradient(135deg, #111a27 0%, #0a0f17 100%)', color: '#e8edf5',
        fontFamily: 'sans-serif',
      }}>
        {/* header */}
        <div style={{ position: 'absolute', left: L, top: 26, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 2, color, textTransform: 'uppercase' }}>{route}</div>
          <div style={{ fontSize: 17, color: '#93a0b4', marginTop: 6 }}>Live from the bus</div>
        </div>
        <div style={{ position: 'absolute', right: R, top: 18, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ fontSize: 54, fontWeight: 800, lineHeight: 1 }}>{big}</div>
          <div style={{ fontSize: 18, color: '#93a0b4', marginTop: 6 }}>{small}</div>
        </div>

        {/* the road */}
        <div style={{ position: 'absolute', left: L, top: Y - 3, width: W - L - R, height: 6, borderRadius: 3, background: '#2a3546', display: 'flex' }} />
        <div style={{ position: 'absolute', left: L, top: Y - 3, width: Math.max(0, x(p) - L), height: 6, borderRadius: 3, background: color, display: 'flex' }} />

        {/* stops */}
        {stops.map((f, i) => (
          <div key={i} style={{
            position: 'absolute', left: x(f) - 6, top: Y - 6, width: 12, height: 12, borderRadius: 6,
            background: f <= p ? color : '#0a0f17', border: `3px solid ${f <= p ? color : '#4a586d'}`, display: 'flex',
          }} />
        ))}

        {/* your stop */}
        {mine != null && (
          <div style={{ position: 'absolute', left: x(mine) - 15, top: Y - 15, width: 30, height: 30, borderRadius: 15,
            border: `4px solid #ffffff`, background: color, display: 'flex' }} />
        )}
        {mine != null && name && (
          <div style={{ position: 'absolute', left: Math.min(Math.max(x(mine) - 110, 8), W - 228), top: Y + 24, width: 220,
            display: 'flex', justifyContent: 'center', fontSize: 18, fontWeight: 700 }}>{name}</div>
        )}

        {/* the bus */}
        <div style={{ position: 'absolute', left: x(p) - 24, top: Y - 24, width: 48, height: 48, borderRadius: 24,
          background: '#ffffff', border: `4px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="18" viewBox="0 0 32 20">
            <circle cx="9" cy="15.4" r="2.7" fill="#16305B" />
            <circle cx="23" cy="15.4" r="2.7" fill="#16305B" />
            <rect x="1.5" y="2" width="29" height="12.8" rx="3.4" fill="#16305B" />
            <rect x="4.2" y="4.5" width="5.4" height="4.9" rx="1.2" fill="#fff" />
            <rect x="10.8" y="4.5" width="5.4" height="4.9" rx="1.2" fill="#fff" />
            <rect x="17.4" y="4.5" width="5.4" height="4.9" rx="1.2" fill="#fff" />
            <rect x="27.6" y="11.2" width="2.4" height="1.9" rx=".9" fill="#F5B301" />
          </svg>
        </div>
        <div style={{ position: 'absolute', right: R, bottom: 14, fontSize: 15, color: '#5f6d82', display: 'flex' }}>SVPCET</div>
      </div>
    ),
    {
      width: W,
      height: H,
      headers: { 'Cache-Control': 'public, max-age=600, immutable' },
    },
  );
}
