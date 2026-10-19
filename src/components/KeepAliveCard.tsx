'use client';

import { useEffect, useState } from 'react';
import { isNativeApp } from '@/lib/tracker';
import { haptic } from '@/lib/device';

/**
 * The one setup step Android will not let us do for the driver.
 *
 * Stock Android keeps a location foreground service alive. The phones our
 * drivers actually own do not. Xiaomi, Oppo, Vivo and Realme each ship their
 * own battery manager on top of Android that kills background work whatever
 * the system permissions say — reported repeatedly against this very plugin,
 * with the foreground notification still visible while location updates had
 * already stopped. There is no API to ask for an exemption and no way to
 * detect that it has happened. The only fix is a human turning Autostart on,
 * once, per phone.
 *
 * So we ask. Once, on the driver's own screen, with the steps for the phone
 * in his hand rather than a generic "check your battery settings" that he
 * would reasonably ignore.
 *
 * Shown only in the app — a browser tab has a different and more honest
 * problem, which the Drive screen already explains.
 */

interface Guide { brand: string; steps: string[] }

/**
 * Which battery manager are we up against?
 *
 * The Android WebView user agent carries the device model — "Android 13;
 * Redmi Note 10" — so the model string is the only signal we need, and it
 * costs no permission to read. Matching is deliberately broad: Redmi and Poco
 * are Xiaomi, and Oppo's own model codes begin CPH.
 */
function guideFor(ua: string): Guide | null {
  const s = ua.toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k));

  if (has('xiaomi', 'redmi', 'poco', 'miui')) {
    return {
      brand: 'Xiaomi / Redmi / Poco',
      steps: [
        'Settings → Apps → Manage apps → SVPCET Bus',
        'Turn ON "Autostart"',
        'Open "Battery saver" and choose "No restrictions"',
        'In Recents, pull the app card down and tap the lock icon',
      ],
    };
  }
  if (has('oppo', 'cph', 'coloros')) {
    return {
      brand: 'Oppo',
      steps: [
        'Settings → Battery → App battery management → SVPCET Bus',
        'Turn ON "Allow background activity"',
        'Settings → Apps → SVPCET Bus → turn ON "Allow auto launch"',
      ],
    };
  }
  if (has('realme', 'rmx')) {
    return {
      brand: 'Realme',
      steps: [
        'Settings → Battery → App battery management → SVPCET Bus',
        'Turn ON "Allow background activity" and "Allow auto launch"',
        'Set battery usage to "Unrestricted"',
      ],
    };
  }
  if (has('vivo', 'iqoo', 'funtouch', 'originos')) {
    return {
      brand: 'Vivo',
      steps: [
        'Settings → Battery → Background power consumption management',
        'Find SVPCET Bus and choose "Allow high background power consumption"',
        'Settings → Apps → Autostart → turn SVPCET Bus ON',
      ],
    };
  }
  if (has('samsung', 'sm-')) {
    return {
      brand: 'Samsung',
      steps: [
        'Settings → Apps → SVPCET Bus → Battery',
        'Choose "Unrestricted"',
        'Settings → Battery → Background usage limits → make sure the app is NOT in "Sleeping apps"',
      ],
    };
  }
  // Stock Android and anything we have not been bitten by yet: one generic
  // step that is true everywhere, rather than a wrong brand's menu path.
  if (has('android')) {
    return {
      brand: 'Android',
      steps: [
        'Settings → Apps → SVPCET Bus → Battery',
        'Choose "Unrestricted" (or turn battery optimisation OFF)',
      ],
    };
  }
  return null;
}

const DONE_KEY = 'campusbus.keepAliveDone';

export function KeepAliveCard() {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isNativeApp()) return;
    try { if (localStorage.getItem(DONE_KEY)) return; } catch { /* private mode: just show it */ }
    setGuide(guideFor(navigator.userAgent));
  }, []);

  if (!guide) return null;

  const done = () => {
    haptic('select');
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* it will ask again, which is safe */ }
    setGuide(null);
  };

  return (
    <div className="card enter" data-i="1">
      <div className="card-head">
        <span className="card-title">One-time phone setup</span>
        <span className="badge" data-tone="warn" style={{ marginLeft: 'auto' }}>{guide.brand}</span>
      </div>

      <div className="note" style={{ margin: '0 17px 13px', borderLeftColor: 'var(--warn)' }}>
        <strong style={{ color: 'var(--warn)' }}>Do this once.</strong>{' '}
        This phone can shut the app down while you are driving, even with the
        tracking notification showing. Students would stop seeing the bus and
        you would get no warning.
      </div>

      {open && (
        <ol className="ka-steps">
          {guide.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}

      <div className="dv-action" style={{ gap: 9 }}>
        {!open ? (
          <button className="btn dv-btn" data-primary="true"
            onClick={() => { haptic('tick'); setOpen(true); }}>
            Show me the steps
          </button>
        ) : (
          <button className="btn dv-btn" data-primary="true" onClick={done}>
            Done — don’t show again
          </button>
        )}
        {open && (
          <button className="btn" onClick={() => { haptic('tick'); setOpen(false); }}>
            Later
          </button>
        )}
      </div>
    </div>
  );
}
