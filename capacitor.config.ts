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
const SITE = process.env.CAPACITOR_SERVER_URL ?? 'https://campus-bus-8v6y.onrender.com';

// Opens straight on the driver's screen, not the students' Track page. This
// app exists for one person doing one job at 7am, and making him tap through
// a screen built for someone else is a small tax he would pay every morning.
// He still reaches Track from the nav if he ever wants it.
const LIVE_URL = `${SITE}/drive`;

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

  plugins: {
    /**
     * Keep the web view BELOW the status bar.
     *
     * Android 15 draws apps edge to edge by default, so the page started at the
     * very top of the screen and the nav tabs sat underneath the clock and
     * battery icon — visible, but not reliably tappable. CSS safe-area insets
     * are the usual answer and they are unreliable here, so this settles it
     * natively instead: the system simply does not give us that strip.
     */
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#080b11',
    },
  },

  android: {
    // The driver may be on a village road with no signal for minutes. Failing
    // the whole page on one bad request would end the trip.
    allowMixedContent: false,

    /**
     * WITHOUT THIS, TRACKING DIES AFTER FIVE MINUTES.
     *
     * Capacitor's modern bridge serves the app through a local HTTP server.
     * Android treats a backgrounded page on that bridge as idle and stops
     * delivering location to it after about five minutes — the foreground
     * service is still alive, the notification is still showing, and the
     * fixes simply stop. The driver sees nothing wrong. Students watch the
     * bus glide to a halt.
     *
     * The plugin documents this and the legacy bridge is the fix:
     * node_modules/@capacitor-community/background-geolocation/README.md:165
     * and https://github.com/capacitor-community/background-geolocation/issues/89
     *
     * This is half the fix. The other half is in lib/api.ts — Android also
     * throttles HTTP that the WebView itself initiates, so the fixes we do
     * keep receiving have to be POSTed natively.
     */
    useLegacyBridge: true,
  },
};

export default config;
