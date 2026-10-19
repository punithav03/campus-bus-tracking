'use client';

/**
 * A script that runs before first paint, without React's dev warning.
 *
 * The server sends it as text/javascript, so the browser runs it while parsing
 * the HTML — before anything is painted. On the client React renders the same
 * element as text/plain, so it never complains about a script in a component;
 * suppressHydrationWarning covers the one attribute that differs. This is the
 * pattern from Next's own guide (preventing-flash-before-hydration).
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
