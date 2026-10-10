import { NextResponse } from 'next/server';
import { sessionFromRequest } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Who am I? Used by the client to decide what to render before anything else. */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) {
    return NextResponse.json({ user: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(
    {
      user: {
        id: s.sub,
        name: s.name,
        role: s.role,
        routeId: s.routeId,
        mustChangePassword: !!s.mustChangePassword,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
