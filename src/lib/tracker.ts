'use client';

import type { Fix } from './recorder-db';

/**
 * One way to follow the bus, whichever shell we happen to be running in.
 *
 * The web page and the Android app read GPS through completely different
 * doors, and the difference is not cosmetic — it is the whole reason the
 * Android app exists:
 *
 *   BROWSER   navigator.geolocation stops the moment the screen locks or the
 *             app is backgrounded. Android enforces this and no permission
 *             changes it. Measured on the real ride of 22 Aug: 16 km of a
 *             33 km trip captured, the rest lost across 16 dropouts, the
 *             longest 210 seconds — during which the bus travelled 1.4 km
 *             invisibly.
 *
 *   ANDROID   a foreground service keeps reading GPS with the screen off and
 *             the phone in a pocket. Android requires a visible notification
 *             while it runs, which is a fair trade and honest to the driver.
 *
 * /drive should not have to know which it got. It calls start(), receives
 * fixes, and calls stop().
 */

export type TrackerKind = 'native' | 'browser';

export interface Tracker {
  kind: TrackerKind;
  stop: () => Promise<void>;
}

/** True when running inside the Android wrapper rather than a browser tab. */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try { return !!cap?.isNativePlatform?.(); } catch { return false; }
}

/**
 * Starts following the bus.
 *
 * `onFix` is called for every usable reading. `onError` is called with
 * something a driver can act on — not a raw platform message.
 */
export async function startTracking(
  onFix: (fix: Fix) => void,
  onError: (message: string) => void,
): Promise<Tracker> {
  if (isNativeApp()) {
    try {
      return await startNative(onFix, onError);
    } catch {
      // If the plugin is missing or refuses, the browser path still works
      // while the screen is on. Degraded, but not dead.
      onError('Background tracking unavailable — keep the screen on.');
    }
  }
  return startBrowser(onFix, onError);
}

// ---------------------------------------------------------------------------

async function startNative(
  onFix: (fix: Fix) => void,
  onError: (message: string) => void,
): Promise<Tracker> {
  const { registerPlugin } = await import('@capacitor/core');
  const BackgroundGeolocation = registerPlugin<{
    addWatcher(
      options: {
        backgroundMessage?: string;
        backgroundTitle?: string;
        requestPermissions?: boolean;
        stale?: boolean;
        distanceFilter?: number;
      },
      callback: (position?: NativeLocation, error?: { code?: string; message: string }) => void,
    ): Promise<string>;
    removeWatcher(options: { id: string }): Promise<void>;
    openSettings(): Promise<void>;
  }>('BackgroundGeolocation');

  const id = await BackgroundGeolocation.addWatcher(
    {
      // Supplying backgroundMessage is what actually turns on background
      // updates — without it the plugin only promises them in the foreground.
      backgroundTitle: 'Tracking the bus',
      backgroundMessage: 'Students can see where the bus is.',
      requestPermissions: true,
      // Never hand back a cached position. A stale fix on a moving bus puts
      // the marker somewhere the bus has already left.
      stale: false,
      // Every metre. The engine does its own filtering and would rather have
      // too much than gaps.
      distanceFilter: 0,
    },
    (position, error) => {
      if (error) {
        if (error.code === 'NOT_AUTHORIZED') {
          onError('Location permission is off. Open settings and allow it "all the time".');
        } else {
          onError(error.message || 'Location unavailable.');
        }
        return;
      }
      if (!position) return;
      onFix({
        t: position.time ?? Date.now(),
        lat: position.latitude,
        lng: position.longitude,
        spd: position.speed,
        acc: position.accuracy,
        alt: position.altitude,
        heading: position.bearing,
      });
    },
  );

  return {
    kind: 'native',
    stop: async () => { await BackgroundGeolocation.removeWatcher({ id }); },
  };
}

interface NativeLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  bearing: number | null;
  speed: number | null;
  time: number | null;
}

// ---------------------------------------------------------------------------

function startBrowser(
  onFix: (fix: Fix) => void,
  onError: (message: string) => void,
): Tracker {
  if (!('geolocation' in navigator)) {
    onError('This browser has no GPS access.');
    return { kind: 'browser', stop: async () => {} };
  }

  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({
      t: pos.timestamp || Date.now(),
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      spd: pos.coords.speed ?? null,
      acc: pos.coords.accuracy ?? null,
      alt: pos.coords.altitude ?? null,
      heading: pos.coords.heading ?? null,
    }),
    (e) => onError(e.message ? `GPS: ${e.message}` : 'GPS signal lost — hold the phone near a window.'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );

  return {
    kind: 'browser',
    stop: async () => navigator.geolocation.clearWatch(id),
  };
}
