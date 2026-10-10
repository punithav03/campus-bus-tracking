import { NextResponse } from 'next/server';
import { changePassword } from '@/lib/accounts';
import { sessionFromRequest, signSession, setSessionCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  let current = '';
  let next = '';
  try {
    const b = await req.json();
    current = String(b?.current ?? '');
    next = String(b?.next ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  }

  const res = await changePassword(s, current, next);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });

  // Re-issue the cookie so mustChangePassword stops being true without a
  // sign-out and back in.
  const { token, expires } = signSession({
    sub: s.sub, role: s.role, name: s.name, routeId: s.routeId, mustChangePassword: false,
  });
  await setSessionCookie(token, expires);

  return NextResponse.json({ ok: true });
}
