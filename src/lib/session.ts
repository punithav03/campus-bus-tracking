import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Who is signed in, carried in a cookie.
 *
 * This is a hand-rolled JWT rather than a library, and that is a considered
 * choice: the whole thing is HMAC-SHA256 over two base64url segments, it has no
 * dependency to go stale against Next's release pace, and every line of it can
 * be read in one sitting. A credentials-only app with three roles does not need
 * more.
 *
 * The token holds the role and, for students and drivers, the route they belong
 * to. That matters: the API reads routeId FROM HERE and never from the request,
 * so a student cannot ask for another route's bus by editing a URL. The cookie
 * is signed, so he cannot edit the claim either.
 */

export type Role = 'student' | 'driver' | 'admin';

export interface Session {
  /** roll number, driver mobile, or admin id */
  sub: string;
  role: Role;
  name: string;
  /** null for admins, who are not bound to one route */
  routeId: string | null;
  mustChangePassword?: boolean;
  /** token id — lets a single session be reasoned about in logs */
  jti: string;
  iat: number;
  exp: number;
}

export const COOKIE = 'svpcet_session';

/**
 * Make a first sign-in choose a new password before anything else.
 *
 * Off at the college's request: students and drivers sign in with their ID
 * as the password and go straight in. They can still change it any time in
 * Settings. Set to true to bring the forced change back — every account the
 * office creates is still marked, so it applies again at once.
 */
export const FORCE_PASSWORD_CHANGE = false;
const MAX_AGE_S = 60 * 60 * 24 * 30;   // a month; a student should not re-login weekly

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error('AUTH_SECRET is missing or too short — set a long random value in .env.local');
  }
  return s;
}

const b64u = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function signature(body: string): string {
  return b64u(createHmac('sha256', secret()).update(body).digest());
}

export function signSession(
  claims: Omit<Session, 'iat' | 'exp' | 'jti'>,
): { token: string; expires: Date } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + MAX_AGE_S;
  const payload: Session = { ...claims, jti: randomUUID(), iat, exp };
  const body = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return { token: `${body}.${signature(body)}`, expires: new Date(exp * 1000) };
}

/** Verifies the signature and the expiry. Returns null on anything suspect. */
export function verifySession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const body = `${parts[0]}.${parts[1]}`;
  const given = unb64u(parts[2]);
  const want = unb64u(signature(body));
  // Equal lengths first: timingSafeEqual throws on a mismatch, and throwing
  // would itself leak that the length was wrong.
  if (given.length !== want.length) return null;
  if (!timingSafeEqual(given, want)) return null;

  try {
    const s = JSON.parse(unb64u(parts[1]).toString('utf8')) as Session;
    if (!s.sub || !s.role || typeof s.exp !== 'number') return null;
    if (s.exp * 1000 < Date.now()) return null;
    // Also clears it on cookies issued while the forced change was on.
    if (!FORCE_PASSWORD_CHANGE) s.mustChangePassword = false;
    return s;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- server side

/** The signed-in user on the server, or null. */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(COOKIE)?.value);
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,                                   // JavaScript can never read it
    secure: process.env.NODE_ENV === 'production',    // https only once deployed
    sameSite: 'lax',                                  // survives a normal link click, blocks CSRF
    path: '/',
    expires,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/** Read the session straight off a Request — for route handlers. */
export function sessionFromRequest(req: Request): Session | null {
  const raw = req.headers.get('cookie') ?? '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return verifySession(hit?.slice(COOKIE.length + 1));
}
