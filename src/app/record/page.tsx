'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { PinGate } from '@/components/PinGate';
import { authFetch } from '@/lib/client-auth';
import { haptic } from '@/lib/device';
import { fmtClock } from '@/lib/format';
import {
  addMarker, appendFixes, createSession, deleteSession, deleteMarker, exportSession,
  listMarkers, renameMarker, type StoredMarker,
  listSessions, storageEstimate, type Fix, type Session,
} from '@/lib/recorder-db';

/**
 * Route recorder.
 *
 * This page talks to NO server. Ride the bus with mobile data switched off if
 * you like — every fix goes straight to IndexedDB on the phone. Export it when
 * you get home and it becomes a real route: road shape, stop positions, and the
 * time profile that drives the ETAs.
 *
 * This is the ride that has to happen before any tracking is possible, because
 * until the system knows the road the bus actually takes, it has nothing to
 * project GPS fixes onto.
 */

const FLUSH_MS = 8000;
const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const two = (n: number) => String(n).padStart(2, '0');
function hms(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

function RecordPageInner() {
  const [session, setSession] = useState<Session | null>(null);
  const [recording, setRecording] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ usedMB: number; quotaMB: number } | null>(null);
  const [sent, setSent] = useState<Record<string, 'sending' | 'done' | 'failed'>>({});

  const [fixCount, setFixCount] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  const [marks, setMarks] = useState<StoredMarker[]>([]);
  const [justMarked, setJustMarked] = useState(false);
  /** True once a fix accurate enough to mark a stop with has arrived. */
  const [hasFix, setHasFix] = useState(false);
  const [distanceM, setDistanceM] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [acc, setAcc] = useState<number | null>(null);
  const [spd, setSpd] = useState<number | null>(null);
  const [pending, setPending] = useState(0);

  const buffer = useRef<Fix[]>([]);
  const last = useRef<Fix | null>(null);
  const dist = useRef(0);
  const count = useRef(0);
  const watchId = useRef<number | null>(null);
  const flusher = useRef<ReturnType<typeof setInterval> | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const refresh = useCallback(async () => {
    setSessions(await listSessions().catch(() => []));
    setStorage(await storageEstimate().catch(() => null));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const flush = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    const batch = buffer.current;
    buffer.current = [];
    setPending(0);
    try {
      await appendFixes(s.id, batch, {
        fixCount: count.current,
        distanceM: Math.round(dist.current),
        endedAt: null,
      });
    } catch (e) {
      // Never lose data: put it back and try again on the next flush.
      buffer.current = [...batch, ...buffer.current];
      setPending(buffer.current.length);
      setErr(`Storage error: ${(e as Error).message}`);
    }
  }, []);

  const start = useCallback(async () => {
    if (!('geolocation' in navigator)) { setErr('This browser has no GPS access.'); return; }
    if (!window.isSecureContext) {
      setErr('Location needs a secure page. Open this over https:// or on localhost.');
      return;
    }
    setErr(null);

    const s = await createSession(name.trim() || `Ride ${new Date().toLocaleString()}`);
    sessionRef.current = s;
    setSession(s);
    buffer.current = []; last.current = null;
    dist.current = 0; count.current = 0;
    setFixCount(0); setMarkerCount(0); setDistanceM(0); setElapsed(0); setPending(0);
    setMarks([]); setHasFix(false);

    try {
      const nav = navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) wakeLock.current = await nav.wakeLock.request('screen');
    } catch { /* the ride still records with the screen off */ }

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: Fix = {
          t: pos.timestamp || Date.now(),
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          spd: pos.coords.speed ?? null,
          acc: pos.coords.accuracy ?? null,
          alt: pos.coords.altitude ?? null,
          heading: pos.coords.heading ?? null,
        };
        // Keep everything, but only count movement between usable fixes.
        if (last.current && (fix.acc ?? 999) < 50) {
          const step = haversine(last.current, fix);
          if (step < 400) dist.current += step;
        }
        if ((fix.acc ?? 999) < 50) { last.current = fix; setHasFix(true); }

        buffer.current.push(fix);
        count.current += 1;
        setFixCount(count.current);
        setPending(buffer.current.length);
        setDistanceM(Math.round(dist.current));
        setAcc(fix.acc);
        setSpd(fix.spd);
      },
      (e) => setErr(e.message ? `GPS: ${e.message}` : 'GPS signal lost — hold the phone near a window.'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );

    flusher.current = setInterval(() => void flush(), FLUSH_MS);
    ticker.current = setInterval(() => setElapsed(Date.now() - s.startedAt), 1000);
    setRecording(true);
  }, [name, flush]);

  const stop = useCallback(async () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (flusher.current) clearInterval(flusher.current);
    if (ticker.current) clearInterval(ticker.current);
    flusher.current = null; ticker.current = null;

    await flush();
    const s = sessionRef.current;
    if (s) {
      await appendFixes(s.id, [], {
        endedAt: Date.now(),
        fixCount: count.current,
        distanceM: Math.round(dist.current),
      });
    }
    try { await wakeLock.current?.release(); } catch { /* already released */ }
    wakeLock.current = null;
    setRecording(false);
    sessionRef.current = null;
    setSession(null);
    await refresh();
  }, [flush, refresh]);

  /**
   * Flag a stop. ONE TAP — no name asked for.
   *
   * It used to open a prompt() for the stop name, which meant standing on a
   * bus that halts for twenty seconds and typing a village name into a modal
   * before the mark was saved. Miss the window and the position is wrong or
   * the mark never happens at all. The position is the part that cannot be
   * recovered later; the name can be typed at the next red light, or at home
   * that evening. So capture the position instantly and name it afterwards.
   */
  const mark = useCallback(async () => {
    const s = sessionRef.current;
    const l = last.current;
    if (!s || !l) return;
    haptic('select');
    await addMarker(s.id, { t: Date.now(), lat: l.lat, lng: l.lng, label: '' });
    setMarkerCount((m) => m + 1);
    setMarks(await listMarkers(s.id));
    // Confirm it landed without the rider having to read anything.
    setJustMarked(true);
    setTimeout(() => setJustMarked(false), 1200);
  }, []);

  const nameMark = useCallback(async (key: number, label: string) => {
    setMarks((ms) => ms.map((m) => (m.key === key ? { ...m, label } : m)));
    await renameMarker(key, label);
  }, []);

  const removeMark = useCallback(async (key: number) => {
    const s = sessionRef.current;
    if (!s) return;
    haptic('tick');
    await deleteMarker(key, s.id);
    setMarks(await listMarkers(s.id));
    setMarkerCount((m) => Math.max(0, m - 1));
  }, []);

  // Flush whenever the phone backgrounds the tab — that is exactly when a
  // browser is most likely to discard the page.
  useEffect(() => {
    const onHide = () => { if (sessionRef.current) void flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [flush]);

  // Screen wake-locks are dropped when the tab is hidden; take it back.
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState !== 'visible' || !recording) return;
      try {
        const nav = navigator as unknown as {
          wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
        };
        if (nav.wakeLock) wakeLock.current = await nav.wakeLock.request('screen');
      } catch { /* fine */ }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [recording]);

  const save = async (s: Session) => {
    const data = await exportSession(s.id);
    const json = JSON.stringify(data);
    const file = new File([json], `${s.id}.json`, { type: 'application/json' });

    const nav = navigator as unknown as {
      share?: (d: { files?: File[]; title?: string }) => Promise<void>;
      canShare?: (d: { files?: File[] }) => boolean;
    };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try { await nav.share({ files: [file], title: s.name }); return; } catch { /* fell through */ }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  /**
   * Send the ride straight to the server, so whoever rode the bus does not also
   * have to be whoever processes it. Nothing is uploaded during the ride — this
   * is deliberate, and runs afterwards when there is signal.
   */
  const upload = async (s: Session) => {
    setSent((m) => ({ ...m, [s.id]: 'sending' }));
    try {
      const data = await exportSession(s.id);
      const res = await authFetch('/api/recording', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSent((m) => ({ ...m, [s.id]: 'done' }));
    } catch {
      // The recording is still safe on the phone — uploading can be retried.
      setSent((m) => ({ ...m, [s.id]: 'failed' }));
    }
  };

  const remove = async (s: Session) => {
    if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    await deleteSession(s.id);
    await refresh();
  };

  return (
    <div className="shell" style={{ ['--accent' as string]: '#34d399', maxWidth: 640 }}>
      <TopBar subtitle="Route recorder" />

      <div className="card enter" data-i="0">
        <div className="card-head">
          <span className="card-title">{recording ? 'Recording' : 'Record a route'}</span>
          {recording && (
            <span className="badge" data-tone="bad" style={{ marginLeft: 'auto' }}>
              <span className="rec-dot" />recording
            </span>
          )}
        </div>

        <div className="card-body" style={{ display: 'grid', gap: 16 }}>
          {!recording && (
            <>
              <div className="note">
                Ride the bus with this open. Nothing is uploaded — every fix is saved
                on this phone, so mobile data can be off the whole way. Export it when
                you get home and it becomes a real route.
              </div>
              <div className="field">
                <span className="field-label">Name this ride</span>
                <input
                  className="input" value={name} placeholder="Pichatur → College, morning"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </>
          )}

          <div className="ctl-row">
            {!recording ? (
              <button className="btn" data-primary="true" onClick={start}>● Start recording</button>
            ) : (
              <>
                <button
                  className="btn mark-btn"
                  data-primary="true"
                  data-flash={justMarked || undefined}
                  onClick={mark}
                  disabled={!hasFix}
                  title={hasFix ? 'Flag this stop' : 'Waiting for a GPS fix'}
                >
                  {justMarked ? '✓ Marked' : hasFix ? '⚑ Mark stop' : '⚑ Waiting for GPS…'}
                </button>
                <button className="btn" data-danger="true" onClick={stop}>■ Finish</button>
              </>
            )}
          </div>

          {err && <div className="note" style={{ borderLeftColor: 'var(--bad)' }}>{err}</div>}
        </div>

        {recording && marks.length > 0 && (
          <div className="card">
            <div className="card-head">
              <div className="card-title">Stops flagged</div>
              <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--dimmer)' }}>
                {marks.length}
              </div>
            </div>
            <div className="card-body">
              <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>
                Names can wait. Tap the flag at every stop and fill these in when
                the bus is moving, or after the ride.
              </div>
              {/* Newest first: the one just flagged is the one being named. */}
              {[...marks].reverse().map((m, i) => (
                <div className="markrow" key={m.key}>
                  <div className="markrow-n num">{marks.length - i}</div>
                  <input
                    className="markrow-name"
                    value={m.label}
                    placeholder="Stop name…"
                    aria-label={'Name for stop ' + (marks.length - i)}
                    onChange={(e) => void nameMark(m.key, e.target.value)}
                  />
                  <div className="markrow-t num">{fmtClock(m.t)}</div>
                  <button
                    className="markrow-x"
                    onClick={() => void removeMark(m.key)}
                    aria-label={'Remove stop ' + (marks.length - i)}
                    title="Remove — tapped by mistake"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {recording && (
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-k">Elapsed</div>
              <div className="stat-v num">{hms(elapsed)}</div>
            </div>
            <div className="stat">
              <div className="stat-k">Distance</div>
              <div className="stat-v num">{(distanceM / 1000).toFixed(2)}<small>km</small></div>
            </div>
            <div className="stat">
              <div className="stat-k">Fixes</div>
              <div className="stat-v num">{fixCount}</div>
            </div>
            <div className="stat">
              <div className="stat-k">Stops marked</div>
              <div className="stat-v num">{markerCount}</div>
            </div>
            <div className="stat">
              <div className="stat-k">GPS ±</div>
              <div className="stat-v num">{acc == null ? '—' : Math.round(acc)}<small>m</small></div>
            </div>
            <div className="stat">
              <div className="stat-k">Speed</div>
              <div className="stat-v num">{spd == null ? '—' : Math.round(spd * 3.6)}<small>km/h</small></div>
            </div>
            <div className="stat">
              <div className="stat-k">Unsaved</div>
              <div className="stat-v num" style={{ color: pending > 40 ? 'var(--warn)' : undefined }}>
                {pending}
              </div>
            </div>
            <div className="stat">
              <div className="stat-k">Storage</div>
              <div className="stat-v num" style={{ fontSize: 15 }}>
                {storage ? `${storage.usedMB}MB` : '—'}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card enter" data-i="1" style={{ marginTop: 18 }}>
        <div className="card-head">
          <span className="card-title">Saved on this phone</span>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--dimmer)' }}>
            {sessions.length} recording{sessions.length === 1 ? '' : 's'}
          </span>
        </div>
        {sessions.length === 0 ? (
          <div className="empty">
            Nothing recorded yet.<br />
            Your first ride is the one that makes everything else possible.
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} style={{
              display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto auto',
              gap: 8, alignItems: 'center', padding: '13px 16px',
              borderBottom: '1px solid var(--line-soft)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--dimmer)' }} className="num">
                  {new Date(s.startedAt).toLocaleDateString()} ·{' '}
                  {(s.distanceM / 1000).toFixed(1)} km · {s.fixCount} fixes
                  {s.markerCount > 0 && ` · ${s.markerCount} marked`}
                  {s.endedAt == null && ' · unfinished'}
                </div>
              </div>
              <button
                className="btn"
                data-primary={sent[s.id] !== 'done'}
                onClick={() => upload(s)}
                disabled={sent[s.id] === 'sending'}
                style={{ padding: '7px 12px', fontSize: 12 }}
              >
                {sent[s.id] === 'sending' ? 'Sending…'
                  : sent[s.id] === 'done' ? '✓ Sent'
                  : sent[s.id] === 'failed' ? 'Retry' : '↑ Upload'}
              </button>
              <button className="btn" onClick={() => save(s)} style={{ padding: '7px 12px', fontSize: 12 }}>
                Export
              </button>
              <button className="btn" onClick={() => remove(s)}
                      style={{ padding: '7px 10px', fontSize: 12, color: 'var(--dim)' }}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card enter" data-i="2" style={{ marginTop: 18 }}>
        <div className="card-head"><span className="card-title">After the ride</span></div>
        <div className="card-body">
          <div className="note">
            <strong style={{ color: 'var(--text)' }}>Upload</strong> sends the ride to
            the college. It needs signal, so do it after the trip rather than on the
            bus — the recording stays safely on this phone either way, so a failed
            upload can simply be tried again.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RecordPage() {
  return (
    <PinGate title="Route recorder">
      <RecordPageInner />
    </PinGate>
  );
}
