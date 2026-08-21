import type { Metadata } from 'next';
import { TopBar } from '@/components/TopBar';
import { getNetwork, getRoute } from '@/lib/network';

export const metadata: Metadata = {
  title: 'About — SVPCET Bus',
  description: 'Who made SVPCET Bus, what it covers, and how it works.',
};

// Read at request time rather than baked in at build. The route is the one
// thing on this page most likely to change, and an About page still listing a
// stop the bus no longer serves is worse than no About page at all.
export const dynamic = 'force-dynamic';

/** Matches the rest of the app: a card is a bordered box with a titled head. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><div className="card-title">{title}</div></div>
      <div className="card-body">{children}</div>
    </div>
  );
}

export default function AboutPage() {
  const route = getRoute('route-1');
  const summary = getNetwork().routes.find((r) => r.id === 'route-1');

  const km = route ? (route.lengthM / 1000).toFixed(1) : null;
  const mins = summary?.durationS ? Math.round(summary.durationS / 60) : null;
  const duration = mins == null ? '—'
    : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m`
    : `${mins}m`;

  return (
    <div className="shell" style={{ maxWidth: 640 }}>
      <TopBar subtitle="About" />

      <div className="col" style={{ marginTop: 16 }}>
        <div className="card about-head">
          <div className="about-title">SVPCET Bus</div>
          <div className="about-lede">
            Live tracking for the college bus, from Nagalapuram to campus.
          </div>
        </div>

        <Section title="Who made this">
          <div className="about-name">Punitha V</div>
          <div className="about-sub">
            Computer Science &amp; Engineering, Final Year
            <br />
            Sri Venkatesa Perumal College of Engineering &amp; Technology, Puttur
          </div>
        </Section>

        <Section title="What it covers">
          <div className="about-figs">
            <div><strong className="num">{route?.stops.length ?? '—'}</strong><span>stops</span></div>
            <div><strong className="num">{km ?? '—'}</strong><span>km</span></div>
            <div><strong className="num">{duration}</strong><span>end to end</span></div>
          </div>
          <div className="about-stops">
            {route?.stops.map((s, i) => (
              <span key={s.id}>
                {s.name}
                {i < route.stops.length - 1 && <i aria-hidden> · </i>}
              </span>
            ))}
          </div>
        </Section>

        <Section title="How it works">
          <p className="about-p">
            The bus carries a phone running this app. Every few seconds it sends where
            it is. Your screen works out how far along the route that is, and how long
            until it reaches your stop — based on how fast the bus has actually been
            moving today, not a fixed timetable.
          </p>
          <p className="about-p">
            So the time changes as the bus goes. If it gets held up, your arrival time
            moves with it.
          </p>
        </Section>

        <Section title="What it can and can’t tell you">
          <ul className="about-list">
            <li>Arrival times are estimates. They get sharper as the bus gets closer.</li>
            <li>It only knows where the bus is while the driver has the app running.</li>
            <li>
              If the signal drops it says so — <em>no live signal</em> — instead of
              guessing. A number that looks live but isn’t is worse than no number.
            </li>
          </ul>
        </Section>

        <Section title="Put it on your home screen">
          <p className="about-p">
            If your browser offers to <strong>Install</strong> — a button in the address
            bar, or a banner along the bottom — just tap that. It is the quickest way.
          </p>
          <p className="about-p">
            If you don’t see one: in Chrome open the <strong>⋮</strong> menu and choose{' '}
            <strong>Install app</strong> or <strong>Add to Home screen</strong>. On an
            iPhone, tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.
          </p>
          <p className="about-p">
            Once it’s there it opens full screen like any other app, and still works on
            a weak signal.
          </p>
        </Section>

        <div className="about-foot">Version 1.0 · August 2026</div>
      </div>
    </div>
  );
}
