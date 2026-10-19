import { NextResponse } from 'next/server';
import { requireRoute } from '@/lib/guard';
import { ensureLive } from '@/lib/live';
import { engine } from '@/lib/engine';
import type { Ping, PingSource } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Ingest. Devices batch their fixes and post every 10-30s rather than once per
 * second — it survives tunnels and dead zones (the phone keeps buffering) and
 * cuts request volume by an order of magnitude.
 */
export async function POST(req: Request) {
  // Only a driver (or the office) may move a bus, and only his own. The route
  // is taken from the signed session, so a posted routeId cannot redirect a
  // batch of fixes onto somebody else's bus.
  const g = requireRoute(req, ['driver', 'admin']);
  if (!g.ok) return g.res;
  await ensureLive();

  let body: { routeId?: string; pings?: Ping[]; source?: PingSource };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const { pings, source = 'driver' } = body;
  const routeId = g.routeId!;
  if (!Array.isArray(pings) || pings.length === 0) {
    return NextResponse.json({ error: 'pings[] required' }, { status: 400 });
  }
  if (pings.length > 600) {
    return NextResponse.json({ error: 'batch too large' }, { status: 413 });
  }

  const result = engine.ingest(routeId, pings, source);
  const view = engine.view(routeId);
  return NextResponse.json({
    ...result,
    distAlongM: view?.trip?.distAlongM ?? null,
    // What the driver's screen calls "Travelled": road actually driven, which
    // stops being the same number as progress the moment a stop is skipped.
    drivenM: view?.trip?.drivenM ?? null,
    nextStop: view?.stops.find((s) => s.seq === view.trip?.nextStopSeq)?.name ?? null,
  });
}
