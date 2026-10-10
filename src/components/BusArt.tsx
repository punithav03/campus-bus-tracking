/**
 * The bus on the home screen.
 *
 * Drawn rather than shipped as an image: two kilobytes of SVG instead of
 * forty of PNG, it takes the route's own colour so each route's screen feels
 * like that route, and it stays sharp on every phone.
 *
 * Two things it must get right.
 *
 * COLOUR IS THEMED, NOT FIXED. The body used to be hard-coded white, which
 * is invisible against a pale sky — the light theme turned the hero into an
 * empty box. Everything here is painted through CSS variables so each theme
 * picks its own, and the bus is dark-on-light or light-on-dark accordingly.
 *
 * MOTION MEANS SOMETHING. The road used to scroll and the bus used to bob
 * whether or not a bus existed, which is the app telling a cheerful lie: a
 * student glancing at a moving picture reads it as a moving bus. It animates
 * only when one is genuinely on the road, and the road scrolls at a speed
 * derived from how fast it is actually going.
 */
export function BusArt({
  moving = false,
  speedMps = null,
}: {
  /** True only when a bus is really out there reporting positions. */
  moving?: boolean;
  /** Drives the road speed, so a crawling bus looks like one. */
  speedMps?: number | null;
}) {
  // 12 m/s (about 43 km/h) is the reference pace, drawn at 1.9s per cycle.
  // Clamped so a GPS spike cannot turn the road into a strobe and a bus at
  // walking pace still visibly moves.
  const pace = Math.min(3.2, Math.max(0.45, (speedMps ?? 11) / 11));
  const dur = (1.9 / pace).toFixed(2);

  return (
    <svg
      className="bus-art"
      viewBox="0 0 320 132"
      // Fill the panel instead of letterboxing. Without this the painted sky
      // stopped short of the card edges and left bare strips either side.
      preserveAspectRatio="xMidYMid slice"
      data-moving={moving}
      style={{ ['--road-dur' as string]: `${dur}s` }}
      role="img"
      aria-label={moving ? 'Bus on the way' : 'Bus not running'}
    >
      <defs>
        <linearGradient id="ba-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity=".24" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
        {/* A flat yellow panel reads as a cartoon; a little depth down the
            body reads as a bus. */}
        <linearGradient id="ba-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--bus-shell)" />
          <stop offset="100%" stopColor="var(--bus-shell-2)" />
        </linearGradient>
      </defs>

      {/* Generously oversized: `slice` crops to fill, and a rect that stopped
          at the viewBox edge is exactly what left the white strips. */}
      <rect x="-40" y="-20" width="400" height="172" fill="url(#ba-sky)" />

      {/* Hills — Tirupati has them on every side */}
      <g className="bus-art-hills">
        <path d="M-40 96 L46 68 L96 96 Z" />
        <path d="M58 96 L104 60 L152 96 Z" />
        <path d="M222 96 L268 70 L360 96 Z" />
      </g>

      <rect className="bus-art-road" x="-40" y="96" width="400" height="56" />
      <g className="bus-art-dashes">
        {[-48, 0, 48, 96, 144, 192, 240, 288, 336].map((x) => (
          <rect key={x} x={x} y="112" width="26" height="3" rx="1.5" />
        ))}
      </g>

      <g className="bus-art-body">
        <ellipse className="bus-art-shadow" cx="160" cy="104" rx="72" ry="6" />
        <rect className="bus-art-shell" x="92" y="44" width="136" height="54" rx="12" />
        <rect className="bus-art-win" x="102" y="52" width="30" height="22" rx="5" />
        <rect className="bus-art-win" x="138" y="52" width="30" height="22" rx="5" />
        <rect className="bus-art-win" x="174" y="52" width="30" height="22" rx="5" />
        <rect className="bus-art-door" x="208" y="52" width="14" height="40" rx="4" />
        {/* The dark skirt a school bus has, and above it a thin band in the
            route's own colour so each line still feels like itself. */}
        <rect className="bus-art-band" x="92" y="84" width="136" height="14" rx="3" />
        <rect x="92" y="79" width="136" height="5" fill="var(--accent)" />
        <circle className="bus-art-lamp" cx="224" cy="92" r="3.4" />
        <circle className="bus-art-tail" cx="96" cy="92" r="3" />
        <g className="bus-art-wheel">
          <circle className="bus-art-tyre" cx="118" cy="98" r="11" />
          <circle className="bus-art-hub" cx="118" cy="98" r="4.4" />
        </g>
        <g className="bus-art-wheel">
          <circle className="bus-art-tyre" cx="202" cy="98" r="11" />
          <circle className="bus-art-hub" cx="202" cy="98" r="4.4" />
        </g>
      </g>
    </svg>
  );
}
