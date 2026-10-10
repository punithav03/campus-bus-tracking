import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { requireRoute } from '@/lib/guard';
import { ensureLive } from '@/lib/live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The endpoint every signed-in device polls.
 *
 * Note what is NOT here: a route id from the caller. For a student or a driver
 * the route comes out of the signed session cookie, so editing the URL does
 * nothing — there is no other bus to ask for. Only an admin may name one.
 */
export async function GET(req: Request) {
  const g = requireRoute(req);
  if (!g.ok) return g.res;
  await ensureLive();

  const view = engine.view(g.routeId!);
  if (!view) return NextResponse.json({ error: 'unknown route' }, { status: 404 });

  return NextResponse.json(
    { ...view, replaying: engine.isReplaying(g.routeId!) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
