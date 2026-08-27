import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android wrapper — built for ONE reason.
 *
 * A web page cannot read GPS once the screen locks. Android stops delivering
 * it, deliberately, and there is no flag that changes that. Measured on the
 * real ride of 22 Aug: the browser recorder captured 16 km of a 33 km trip and
 * missed the rest in 16 dropouts, the longest 210 seconds. For a driver who
 * has to put the phone down and drive, that is not a rough edge — it is the
 * feature not working.
 *
 * So the app is a thin native shell that loads the SAME site students use, and
 * adds one thing the browser will not give us: a foreground service that keeps
 * reading GPS with the screen off.
 *
 * It deliberately does NOT bundle the web app. Loading the live URL means the
 * driver's app updates the moment you deploy, exactly like the students' —
 * no rebuilding and re-sending an APK for every change.
 */

// ---------------------------------------------------------------------------
// SET THIS to the live site. Everything the driver sees is served from here.
// Override without editing the file:  CAPACITOR_SERVER_URL=https://... npx cap sync
// ---------------------------------------------------------------------------
const LIVE_URL = process.env.CAPACITOR_SERVER_URL ?? 'https://campus-bus.onrender.com';

const config: CapacitorConfig = {
  appId: 'org.svpcet.bus',
  appName: 'SVPCET Bus',

  // Unused in practice — the app loads LIVE_URL — but the CLI requires a real
  // folder, and public/ is the natural one.
  webDir: 'public',

  server: {
    url: LIVE_URL,
    // https only. The driver's PIN travels over this.
    cleartext: false,
  },

  android: {
    // The driver may be on a village road with no signal for minutes. Failing
    // the whole page on one bad request would end the trip.
    allowMixedContent: false,
  },
};

export default config;
