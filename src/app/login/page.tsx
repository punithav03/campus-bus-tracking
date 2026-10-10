'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { BrandLogo } from '@/components/BrandLogo';
import { haptic } from '@/lib/device';
import { setSessionUser, useSession, homeFor, type User } from '@/lib/useSession';

/**
 * One box, three kinds of people.
 *
 * There is deliberately no "I am a student / driver / admin" chooser. A driver
 * at 7am should type the only two things he knows — his mobile number and his
 * password — and arrive at his bus. The server works out what he is; asking him
 * to classify himself first is our problem leaking into his morning.
 */
export default function LoginPage() {
  const router = useRouter();
  const { phase, user } = useSession();

  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<HTMLInputElement>(null);

  // Already signed in? Don't make them look at a login form.
  useEffect(() => {
    if (phase === 'in' && user) router.replace(homeFor(user.role));
  }, [phase, user, router]);

  useEffect(() => { idRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !id.trim() || !password) return;
    setBusy(true);
    setError(null);
    haptic('tick');

    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), password }),
      });
      const j = await r.json();

      if (!r.ok) {
        setError(j?.error ?? 'Could not sign you in.');
        setBusy(false);
        haptic('alert');
        return;
      }

      haptic('select');
      setSessionUser(j.user as User);
      router.replace(homeFor(j.user.role));
    } catch {
      setError('No connection. Check your internet and try again.');
      setBusy(false);
      haptic('alert');
    }
  }

  return (
    <main className="login">
      <div className="login-glow" aria-hidden />

      <form className="login-card enter" data-i="0" onSubmit={submit}>
        <div className="login-mark">
          <BrandLogo idPrefix="lg" />
        </div>

        <h1 className="login-title">SVPCET Bus</h1>
        <p className="login-sub">Sign in to see your bus</p>

        <label className="field login-field">
          <span className="field-label">Roll number or mobile</span>
          <input
            ref={idRef}
            className="input"
            value={id}
            onChange={(e) => { setId(e.target.value); setError(null); }}
            autoComplete="username"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="21CS001"
            disabled={busy}
          />
        </label>

        <label className="field login-field">
          <span className="field-label">Password</span>
          <div className="input-wrap">
            <input
              className="input"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              autoComplete="current-password"
              enterKeyHint="go"
              placeholder="••••••••"
              disabled={busy}
            />
            <button
              type="button"
              className="input-action"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>

        {/* Reserved height, so the card does not jump when a message appears. */}
        <div className="login-error" data-on={!!error}>{error ?? ''}</div>

        <button
          className="btn login-btn"
          data-primary="true"
          type="submit"
          disabled={busy || !id.trim() || !password}
        >
          {busy ? <span className="spin" aria-hidden /> : null}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login-help">
          First time? Your password is your roll number.
          <br />
          Drivers sign in with their mobile number.
        </p>
      </form>

      {/* The app's own mark is above, on the card. This is the college
          signing it: whose bus service this is, not what the app is. */}
      <div className="login-org">
        <Image
          className="login-crest"
          src="/college-crest.png"
          alt=""
          width={360} height={360} priority
        />
        <p className="login-org-text">
          <strong>Sri Venkatesa Perumal College of Engineering &amp; Technology</strong>
          Puttur · Autonomous
        </p>
      </div>
    </main>
  );
}
