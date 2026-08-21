import { NextResponse } from 'next/server';

/**
 * A single shared PIN, right-sized for a college bus tracker.
 *
 * What actually needs protecting is not the admin *pages* — hiding a link stops
 * nobody, since anyone can type /drive. It is the WRITE endpoints: without a
 * gate, a bored student can start a trip or, worse, post fake positions and
 * move the bus. Reading stays wide open, because that is the product.
 *
 * Set ADMIN_PIN in the host's environment. Never in the code, never in git.
 */
const PIN = (process.env.ADMIN_PIN ?? '').trim();

export const pinRequired = () => PIN.length > 0;

/** Constant-time-ish compare, so the PIN can't be guessed a character at a time. */
function matches(given: string): boolean {
  if (given.length !== PIN.length) return false;
  let diff = 0;
  for (let i = 0; i < PIN.length; i++) diff |= given.charCodeAt(i) ^ PIN.charCodeAt(i);
  return diff === 0;
}

export function checkPin(req: Request): boolean {
  // No PIN configured means local development, where a prompt would only get in
  // the way. Deploying without one is instead surfaced as a warning in the UI,
  // so it cannot happen silently.
  if (!pinRequired()) return true;
  return matches(req.headers.get('x-campus-pin') ?? '');
}

export function unauthorized() {
  return NextResponse.json({ error: 'PIN required' }, { status: 401 });
}
