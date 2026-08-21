'use client';

import { useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { clearPin, setPin } from '@/lib/client-auth';
import { refreshAuth, useAuth } from '@/lib/useAuth';

/**
 * Wraps the pages students should not be operating.
 *
 * The gate is a convenience for the person who belongs here, not the security
 * boundary — that lives on the server, where every write is checked. Someone
 * bypassing this component in devtools still cannot move the bus.
 */
export function PinGate({ children, title }: { children: React.ReactNode; title: string }) {
  const auth = useAuth();
  const [entry, setEntry] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setWrong(false);
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: entry }),
      });
      if (r.ok) {
        setPin(entry);
        await refreshAuth(); // one shared state, so the nav updates too
      } else {
        setWrong(true);
        setEntry('');
      }
    } catch {
      setWrong(true);
    } finally {
      setBusy(false);
    }
  };

  const frame = (body: React.ReactNode) => (
    <div className="shell" style={{ maxWidth: 520 }}>
      <TopBar subtitle={title} />
      <div className="lock">
        <div className="lock-card" data-shake={wrong || undefined} key={wrong ? 'wrong' : 'ok'}>
          {body}
        </div>
      </div>
    </div>
  );

  if (auth.phase === 'checking') {
    return frame(
      <>
        <div className="skel" style={{ width: 56, height: 56, borderRadius: 18, margin: '0 auto 18px' }} />
        <div className="skel" style={{ height: 18, width: '55%', margin: '0 auto 10px' }} />
        <div className="skel" style={{ height: 12, width: '80%', margin: '0 auto' }} />
      </>,
    );
  }

  // Could not reach the server. Locked, never open — an unreachable check is
  // not permission.
  if (auth.phase === 'error') {
    return frame(
      <>
        <div className="lock-icon" style={{ background: 'var(--bg-3)' }}>⚠</div>
        <div className="lock-title">Can&apos;t reach the server</div>
        <div className="lock-sub">
          Whether this page is protected could not be confirmed, so it stays locked.
          Free hosting sleeps when idle — give it a moment.
        </div>
        <button className="btn lock-btn" data-primary="true" onClick={() => void refreshAuth()}>
          Try again
        </button>
      </>,
    );
  }

  if (auth.phase === 'locked') {
    return frame(
      <form onSubmit={submit}>
        <div className="lock-icon">🔒</div>
        <div className="lock-title">{title}</div>
        <div className="lock-sub">
          This page controls the bus. Enter the PIN once — this device will remember it.
        </div>
        <input
          className="lock-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={entry}
          onChange={(e) => { setEntry(e.target.value); setWrong(false); }}
          placeholder="••••"
          aria-label="PIN"
        />
        <button className="btn lock-btn" data-primary="true" disabled={busy || !entry}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
        {wrong && <div className="lock-err">That PIN is not right.</div>}
        <div className="lock-foot">Students don&apos;t need this page.</div>
      </form>,
    );
  }

  return (
    <>
      {/* Deploying with no PIN set is a real mistake, so it is stated plainly
          rather than left for someone to discover. */}
      {!auth.required && (
        <div className="shell" style={{ paddingBottom: 0 }}>
          <div className="note" style={{ borderLeftColor: 'var(--warn)', marginTop: 14 }}>
            <strong style={{ color: 'var(--warn)' }}>No PIN is set.</strong> Anyone who
            finds this page can start trips and post bus positions. Set{' '}
            <span className="mono">ADMIN_PIN</span> in the hosting environment before
            sharing the link.
          </div>
        </div>
      )}
      {children}
    </>
  );
}

/** "Lock this device again" — useful on a shared laptop. */
export function ForgetPin() {
  return (
    <button
      className="btn"
      style={{ padding: '5px 10px', fontSize: 11.5 }}
      onClick={() => { clearPin(); location.reload(); }}
    >
      Lock
    </button>
  );
}
