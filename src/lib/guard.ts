import { NextResponse } from 'next/server';
import { sessionFromRequest, type Role, type Session } from './session';
import { one } from './db';

/**
 * Which route is this request allowed to ask about?
 *
 * The whole access model is one rule: for a student or a driver the route comes
 * from the signed cookie, and the query string is ignored entirely. Not
 * validated — ignored. There is no code path where a student-supplied route id
 * reaches the engine, so there is no code path to get wrong later.
 *
 * Admins are the exception and may name a route, because seeing all of them is
 * the job.
 */

export type Guarded =
  | { ok: true; session: Session; routeId: string | null }
  | { ok: false; res: NextResponse };

const deny = (status: number, error: string): Guarded => ({
  ok: false,
  res: NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } }),
});

/**
 * The bus an account is on NOW, from the database — not the one written into
 * its cookie at sign-in.
 *
 * A cookie lives for weeks. When the office moves a student to another bus, or
 * the routes are rebuilt (the old route ids disappear), a cookie that still
 * named the old route sent the app asking for a bus that no longer existed:
 * the map spun on "Loading the route…" forever. So the route is looked up
 * here, cached for half a minute so the every-few-seconds polling of a
 * thousand phones costs one query per person per 30 s. An account that has
 * been removed or deactivated gets "sign in again".
 */
const CURRENT_TTL_MS = 30_000;
const current = new Map<string, { routeId: string | null; at: number } | null>();
const currentAt = new Map<string, number>();

export async function currentRouteId(session: Session): Promise<string | null | undefined> {
  if (session.role === 'admin') return session.routeId;
  const key = `${session.role}:${session.sub}`;
  const at = currentAt.get(key) ?? 0;
  if (Date.now() - at < CURRENT_TTL_MS && current.has(key)) {
    const c = current.get(key);
    return c === null ? undefined : c!.routeId;
  }
  try {
    const row = session.role === 'student'
      ? await one<{ route_id: string | null }>('SELECT route_id FROM students WHERE upper(roll_no) = upper($1)', [session.sub])
      : await one<{ route_id: string | null }>('SELECT route_id FROM drivers WHERE id = $1 AND active', [session.sub]);
    current.set(key, row ? { routeId: row.route_id, at: Date.now() } : null);
    currentAt.set(key, Date.now());
    if (current.size > 20_000) { current.clear(); currentAt.clear(); }
    return row ? row.route_id : undefined;
  } catch {
    // Database unreachable: the cookie's answer is better than none.
    return session.routeId;
  }
}

export async function requireSession(req: Request, roles?: Role[]): Promise<Guarded> {
  const session = sessionFromRequest(req);
  if (!session) return deny(401, 'Sign in to continue.');
  if (roles && !roles.includes(session.role)) return deny(403, 'Not allowed.');
  // A first password is the admission number or the mobile number — things
  // other people know. Until it is replaced the account can do nothing but
  // replace it; the app's own screen enforces the same, this makes it real.
  if (session.mustChangePassword && session.role !== 'admin') {
    return deny(403, 'Choose a new password to continue.');
  }

  let routeId: string | null = session.routeId;
  if (session.role !== 'admin') {
    const now = await currentRouteId(session);
    if (now === undefined) return deny(401, 'Please sign in again.');
    routeId = now;
  } else {
    // Admins may target any route; no route means "all of them".
    routeId = new URL(req.url).searchParams.get('route');
  }
  return { ok: true, session, routeId };
}

/** Same, but the caller needs a concrete route to work with. */
export async function requireRoute(req: Request, roles?: Role[]): Promise<Guarded> {
  const g = await requireSession(req, roles);
  if (!g.ok) return g;
  if (!g.routeId) {
    return deny(400, g.session.role === 'admin'
      ? 'Name a route.'
      : 'No bus route is assigned to your account — contact the transport office.');
  }
  return g;
}
