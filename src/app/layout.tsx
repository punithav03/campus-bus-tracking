import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { RegisterSW } from '@/components/RegisterSW';
import { PageTransition } from '@/components/PageTransition';
import { Splash } from '@/components/Splash';
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
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#080b11',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <PageTransition>{children}</PageTransition>
        <Splash />
        <RegisterSW />
      </body>
    </html>
  );
}
