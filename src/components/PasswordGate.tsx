'use client';

import { useState } from 'react';
import { useSession, setSessionUser } from '@/lib/useSession';
import { haptic } from '@/lib/device';

/**
 * Forces a new password on first sign-in, and nothing else.
 *
 * Every account is created by the office with a password anyone can guess —
 * a student's is their roll number, a driver's is his mobile. That is the only
 * sane way to hand out a thousand accounts, and it is also useless as a
 * password once it has been used once. So the first thing a new account sees
 * is this, and there is no way past it except setting a real one.
 *
 * It wraps the page rather than being a route of its own, so there is no URL
 * to skip to and no redirect loop to get wrong.
 */
export function PasswordGate({ children }: { children: React.ReactNode }) {
  const { user, refresh } = useSession();
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user?.mustChangePassword) return <>{children}</>;

  const tooShort = next.length > 0 && next.length < 6;
  const mismatch = again.length > 0 && next !== again;
  const ready = next.length >= 6 && next === again && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);

    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The temporary password is the account id — the student does not
        // need to be asked for something he has just typed on the screen
        // before this one.
        body: JSON.stringify({ current: user!.id, next }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.error ?? 'Could not change the password.');
        setBusy(false);
        haptic('alert');
        return;
      }
      haptic('select');
      setSessionUser({ ...user!, mustChangePassword: false });
      refresh();
    } catch {
      setError('No connection. Try again.');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-glow" aria-hidden />
      <form className="login-card enter" data-i="0" onSubmit={submit}>
        <h1 className="login-title">Choose a password</h1>
        <p className="login-sub">
          Welcome, {user.name.split(' ')[0]}. Pick something only you know.
        </p>

        <label className="field login-field">
          <span className="field-label">New password</span>
          <input
            className="input" type="password" value={next} autoFocus
            onChange={(e) => { setNext(e.target.value); setError(null); }}
            autoComplete="new-password" placeholder="At least 6 characters"
            disabled={busy}
          />
        </label>

        <label className="field login-field">
          <span className="field-label">Type it again</span>
          <input
            className="input" type="password" value={again}
            onChange={(e) => { setAgain(e.target.value); setError(null); }}
            autoComplete="new-password" placeholder="••••••••"
            disabled={busy}
          />
        </label>

        <div className="login-error" data-on={!!(error || tooShort || mismatch)}>
          {error ?? (tooShort ? 'Use at least 6 characters.'
                   : mismatch ? 'The two do not match.' : '')}
        </div>

        <button className="btn login-btn" data-primary="true" type="submit" disabled={!ready}>
          {busy ? <span className="spin" aria-hidden /> : null}
          {busy ? 'Saving…' : 'Save and continue'}
        </button>

        <p className="login-help">
          You will use this every time from now on. Your ID stays the same.
        </p>
      </form>
    </main>
  );
}
