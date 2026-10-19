import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { requireRoute } from '@/lib/guard';
import { ensureLive } from '@/lib/live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The road the bus has actually driven this run.
 *
 * Incremental: the caller says which trip it has and how many settled points
 * it already holds (`trip`, `n`), and gets back only what has been added
 * since. The trail only ever grows at its end, so after the first fetch each
 * poll is a few hundred bytes rather than the whole road so far. A caller
 * holding a different trip, or a count that no longer fits, gets the whole
 * trail again with `reset: true`.
 *
 * Route from the session, never the query string — same rule as /api/state.
 */
export async function GET(req: Request) {
  const g = await requireRoute(req);
  if (!g.ok) return g.res;
  await ensureLive();

  const url = new URL(req.url);
  const trip = url.searchParams.get('trip');
  const n = Number(url.searchParams.get('n') ?? '0');

  return NextResponse.json(
    engine.trail(g.routeId!, trip, Number.isFinite(n) ? Math.floor(n) : 0),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
