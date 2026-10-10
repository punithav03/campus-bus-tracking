'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/TopBar';
import { RoleGate } from '@/components/RoleGate';
import { BoardingPicker } from '@/components/BoardingPicker';
import { Confirm } from '@/components/Confirm';
import { ThemeToggle } from '@/components/ThemeToggle';
import { haptic } from '@/lib/device';
import { signOut, useSession } from '@/lib/useSession';
import { getTripState } from '@/lib/trip-session';

/**
 * Settings — for everybody, with the parts that do not apply left out.
 *
 * A student changes where they get on; a driver has no boarding point and so
 * is not shown one. Everyone can change their password and sign out.
 *
 * Signing out lives here rather than in the top bar on purpose. It used to sit
 * one tap from the nav, where a driver mid-run could catch it with a thumb and
 * take the bus off the air for every student watching. Rare and destructive
 * belongs behind a door.
 */
function SettingsInner() {
  const router = useRouter();
  const { user, refresh } = useSession();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [askSignOut, setAskSignOut] = useState(false);

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pwBusy || !cur || next.length < 6) return;
    setPwBusy(true);
    setPwMsg(null);
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: cur, next }),
      });
      const j = await r.json();
      setPwMsg(r.ok ? { ok: true, text: 'Password changed.' }
                    : { ok: false, text: j?.error ?? 'Could not change it.' });
      if (r.ok) { setCur(''); setNext(''); haptic('select'); }
    } catch {
      setPwMsg({ ok: false, text: 'No connection.' });
    }
    setPwBusy(false);
  }

  if (editing) {
    return (
      <main className="bp-screen">
        <BoardingPicker
          mode="settings"
          onCancel={() => setEditing(false)}
          onSaved={() => { setEditing(false); setSaved(true); refresh(); router.refresh(); }}
        />
      </main>
    );
  }

  const role = user?.role;
  const roleWord = role === 'driver' ? 'Driver' : role === 'admin' ? 'Transport office' : 'Student';

  return (
    <div className="shell" style={{ maxWidth: 560 }}>
      <TopBar subtitle="Settings" />

      <section className="card enter" data-i="0">
        <div className="card-head"><span className="card-title">Account</span></div>
        <div className="ti-row">
          <span className="ti-row-k">Signed in as</span>
          <span className="ti-row-v">{user?.name ?? '—'}</span>
        </div>
        <div className="ti-row">
          <span className="ti-row-k">{role === 'student' ? 'Roll number' : 'ID'}</span>
          <span className="ti-row-v num">{user?.id ?? '—'}</span>
        </div>
        <div className="ti-row">
          <span className="ti-row-k">Account type</span>
          <span className="ti-row-v">{roleWord}</span>
        </div>
      </section>

      {role === 'student' && (
        <section className="card enter" data-i="1" style={{ marginTop: 13 }}>
          <div className="card-head"><span className="card-title">Your bus</span></div>
          <button
            className="ti-track" style={{ width: '100%', borderTop: 'none' }}
            onClick={() => { haptic('tick'); setEditing(true); }}
          >
            <span className="ti-track-ic" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M12 2.6c-3.5 0-6.3 2.8-6.3 6.3 0 4.7 6.3 12.5 6.3 12.5s6.3-7.8 6.3-12.5c0-3.5-2.8-6.3-6.3-6.3z"
                      fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="8.9" r="2.4" fill="currentColor" />
              </svg>
            </span>
            Change boarding point
            <span className="ti-track-go" aria-hidden>›</span>
          </button>
          {saved && (
            <div className="note" style={{ margin: '0 17px 17px', borderLeftColor: 'var(--live)' }}>
              <strong style={{ color: 'var(--live)' }}>Saved.</strong>{' '}
              Your home screen now shows the new stop.
            </div>
          )}
        </section>
      )}

      <section className="card enter" data-i="2" style={{ marginTop: 13 }}>
        <div className="card-head"><span className="card-title">Appearance</span></div>
        <div className="imp-body"><ThemeToggle /></div>
      </section>

      <section className="card enter" data-i="3" style={{ marginTop: 13 }}>
        <div className="card-head"><span className="card-title">Password</span></div>
        <form className="imp-body" onSubmit={changePassword}>
          <label className="field">
            <span className="field-label">Current password</span>
            <input className="input" type="password" value={cur} autoComplete="current-password"
                   onChange={(e) => { setCur(e.target.value); setPwMsg(null); }} />
          </label>
          <label className="field">
            <span className="field-label">New password</span>
            <input className="input" type="password" value={next} autoComplete="new-password"
                   placeholder="At least 6 characters"
                   onChange={(e) => { setNext(e.target.value); setPwMsg(null); }} />
          </label>
          {pwMsg && (
            <div className="note" style={{ borderLeftColor: pwMsg.ok ? 'var(--live)' : 'var(--bad)' }}>
              {pwMsg.text}
            </div>
          )}
          <button className="btn" data-primary="true" type="submit"
                  disabled={pwBusy || !cur || next.length < 6}>
            {pwBusy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </section>

      <section className="card enter" data-i="4" style={{ marginTop: 13 }}>
        <button
          className="ti-track set-signout"
          onClick={() => { haptic('tick'); setAskSignOut(true); }}
        >
          <span className="ti-track-ic set-signout-ic" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M14 7.5V5.6A1.6 1.6 0 0 0 12.4 4H5.6A1.6 1.6 0 0 0 4 5.6v12.8A1.6 1.6 0 0 0 5.6 20h6.8a1.6 1.6 0 0 0 1.6-1.6v-1.9"
                    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M10 12h10m0 0-3-3m3 3-3 3"
                    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Sign out
          <span className="ti-track-go" aria-hidden>›</span>
        </button>
      </section>

      <Confirm
        open={askSignOut}
        title="Sign out?"
        danger
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        onCancel={() => setAskSignOut(false)}
        onConfirm={() => { setAskSignOut(false); void signOut(); }}
        body={
          role === 'driver' && getTripState().running ? (
            <>
              <strong style={{ color: 'var(--warn)' }}>Your trip is still running.</strong>{' '}
              Signing out stops broadcasting, and students will lose the bus.
              End the trip first if the run is finished.
            </>
          ) : (
            <>You will need your ID and password to sign back in.</>
          )
        }
      />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <RoleGate allow={['student', 'driver', 'admin']}>
      <SettingsInner />
    </RoleGate>
  );
}
