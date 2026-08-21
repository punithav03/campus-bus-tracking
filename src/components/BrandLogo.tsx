/**
 * The app mark, in one place.
 *
 * Server-renderable on purpose: the launch screen has to be in the very first
 * HTML the browser paints, so it cannot come from a client component. Ids are
 * parameterised because the launch screen and the header mark are on the page
 * at the same time, and duplicate SVG ids make one of them render blank.
 */
export function BrandLogo({ idPrefix }: { idPrefix: string }) {
  const pin = `${idPrefix}-pin`;
  const clipL = `${idPrefix}-l`;
  const clipR = `${idPrefix}-r`;
  return (
    <svg viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="112" fill="#FFFFFF" />
      <g transform="translate(256 262) scale(0.78) translate(-256 -256)">
        <defs>
          <path
            id={pin}
            d="M256 26c95 0 172 77 172 172 0 62-50 140-149 236a33 33 0 0 1-46 0C134 338 84 260 84 198 84 103 161 26 256 26z"
          />
          <clipPath id={clipL}><rect x="0" y="0" width="256" height="512" /></clipPath>
          <clipPath id={clipR}><rect x="256" y="0" width="256" height="512" /></clipPath>
        </defs>
        <use href={`#${pin}`} fill="#F5B301" clipPath={`url(#${clipL})`} />
        <use href={`#${pin}`} fill="#16305B" clipPath={`url(#${clipR})`} />
        <circle cx="256" cy="196" r="118" fill="#FFFFFF" />
        <rect x="186" y="112" width="140" height="150" rx="30" fill="#16305B" />
        <rect x="204" y="136" width="104" height="58" rx="12" fill="#FFFFFF" />
        <circle cx="212" cy="222" r="13" fill="#FFFFFF" />
        <circle cx="300" cy="222" r="13" fill="#FFFFFF" />
        <rect x="240" y="214" width="32" height="11" rx="5.5" fill="#FFFFFF" />
        <rect x="198" y="256" width="26" height="26" rx="8" fill="#16305B" />
        <rect x="288" y="256" width="26" height="26" rx="8" fill="#16305B" />
      </g>
    </svg>
  );
}
