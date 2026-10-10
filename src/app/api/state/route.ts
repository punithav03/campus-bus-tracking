import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { requireRoute } from '@/lib/guard';
import { engineKey } from '@/lib/network';
import { directionNow } from '@/lib/trip-store';
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

  // Morning or afternoon decides which bus "my route" means. The student
  // asking at 16:50 wants the one going home, and it is a different trip on
  // a different line through the same villages.
  const direction = directionNow();
  const key = engineKey(g.routeId!, direction);

  const view = engine.view(key) ?? engine.view(g.routeId!);
  if (!view) return NextResponse.json({ error: 'unknown route' }, { status: 404 });

  return NextResponse.json(
    { ...view, direction, replaying: engine.isReplaying(key) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
