import { NextResponse } from 'next/server';
import { login } from '@/lib/accounts';
import { signSession, setSessionCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One login endpoint for all three roles.
 *
 * The reply deliberately does not say whether the id exists — "check your ID
 * and password" covers both cases, so nobody can walk the roll-number space to
 * find out who is registered.
 */
export async function POST(req: Request) {
  let id = '';
  let password = '';
  try {
    const body = await req.json();
    id = String(body?.id ?? '');
    password = String(body?.password ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  }

  const res = await login(id, password);

  if (!res.ok) {
    return NextResponse.json(
      {
        error: res.reason === 'locked'
          ? 'Too many attempts. Wait ten minutes and try again.'
          : 'Check your ID and password.',
      },
      { status: res.reason === 'locked' ? 429 : 401 },
    );
  }

  const { token, expires } = signSession(res.session);
  await setSessionCookie(token, expires);

  return NextResponse.json({
    ok: true,
    user: {
      id: res.session.sub,
      name: res.session.name,
      role: res.session.role,
      routeId: res.session.routeId,
      mustChangePassword: !!res.session.mustChangePassword,
    },
  });
}
