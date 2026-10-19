import { NextResponse } from 'next/server';
import { sessionFromRequest, type Role, type Session } from './session';

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

export function requireSession(req: Request, roles?: Role[]): Guarded {
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
  if (session.role === 'admin') {
    // Admins may target any route; no route means "all of them".
    routeId = new URL(req.url).searchParams.get('route');
  }
  return { ok: true, session, routeId };
}

/** Same, but the caller needs a concrete route to work with. */
export function requireRoute(req: Request, roles?: Role[]): Guarded {
  const g = requireSession(req, roles);
  if (!g.ok) return g;
  if (!g.routeId) {
    return deny(400, g.session.role === 'admin'
      ? 'Name a route.'
      : 'No bus route is assigned to your account — contact the transport office.');
  }
  return g;
}
