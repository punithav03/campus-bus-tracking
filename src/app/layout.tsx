import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { RegisterSW } from '@/components/RegisterSW';
import { PageTransition } from '@/components/PageTransition';
import { Splash } from '@/components/Splash';
import { BrandLogo } from '@/components/BrandLogo';
import './globals.css';

// Self-hosted at build time — no runtime request to Google, so the app still
// looks right offline on a bus with no signal.
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  fallback: ['system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'Menlo', 'monospace'],
});

export const metadata: Metadata = {
  title: 'Campus Bus — SVPCET',
  description:
    'Live college bus tracking for SVPCET, Puttur. Route-projected positions, learned arrival times, and an honest signal indicator.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Campus Bus' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#080b11',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

/**
 * Painted before the stylesheet arrives, so the launch screen is never a flash
 * of unstyled logo. Only what the first frame needs is here — the rest lives in
 * globals.css and takes over once it loads.
 */
const BOOT_CSS = `
#boot{position:fixed;inset:0;z-index:200;pointer-events:none;
  display:grid;place-items:center;align-content:center;gap:22px;
  background:#080b11;
  background-image:radial-gradient(760px 420px at 50% 34%,rgba(245,179,1,.10),transparent 70%),
                   radial-gradient(680px 380px at 50% 78%,rgba(22,48,91,.35),transparent 70%);
  transition:background-color .5s ease,opacity .3s ease}
#boot[data-phase="fly"]{background-image:none;background-color:transparent}
#boot-logo{width:min(38vw,168px);aspect-ratio:1;border-radius:26%;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.06)}
#boot-logo svg{display:block;width:100%;height:100%}
.boot-word{font:620 15px/1 system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;
  color:#8b97a8;transition:opacity .22s ease}
#boot[data-phase="fly"] .boot-word{opacity:0}
html[data-splash="skip"] #boot,#boot[data-phase="gone"]{display:none}
html[data-splash="running"] .brand-mark{opacity:0}
/* Failsafe. If the JavaScript never arrives, the launch screen must still get
   out of the way rather than holding the app hostage behind a logo. */
#boot{animation:bootGiveUp 0s linear 8s forwards}
@keyframes bootGiveUp{to{opacity:0;visibility:hidden}}
`;

/**
 * Runs before the body paints, so a session that has already seen the launch
 * screen never flashes it a second time on an in-app navigation or a reload.
 */
const BOOT_SKIP = `try{if(sessionStorage.getItem('campusbus.splashShown')==='1')` +
  `document.documentElement.dataset.splash='skip'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: BOOT_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: BOOT_SKIP }} />
      </head>
      <body>
        {/* Server-rendered, so the mark is in the FIRST painted frame and
            continues straight out of the operating system's own splash
            instead of appearing after hydration. */}
        <div id="boot" aria-hidden>
          <div id="boot-logo"><BrandLogo idPrefix="boot" /></div>
          <div className="boot-word">Campus Bus</div>
        </div>
        <PageTransition>{children}</PageTransition>
        <Splash />
        <RegisterSW />
      </body>
    </html>
  );
}
