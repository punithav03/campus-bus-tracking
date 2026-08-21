import { NextResponse } from 'next/server';
import { checkPin, unauthorized } from '@/lib/auth';
import { engine } from '@/lib/engine';
import type { Ping, PingSource } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Ingest. Devices batch their fixes and post every 10-30s rather than once per
 * second — it survives tunnels and dead zones (the phone keeps buffering) and
 * cuts request volume by an order of magnitude.
 */
export async function POST(req: Request) {
  if (!checkPin(req)) return unauthorized();
  let body: { routeId?: string; pings?: Ping[]; source?: PingSource };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const { routeId, pings, source = 'driver' } = body;
  if (!routeId || !Array.isArray(pings) || pings.length === 0) {
    return NextResponse.json({ error: 'routeId and pings[] required' }, { status: 400 });
  }
  if (pings.length > 600) {
    return NextResponse.json({ error: 'batch too large' }, { status: 413 });
  }

  const result = engine.ingest(routeId, pings, source);
  const view = engine.view(routeId);
  return NextResponse.json({
    ...result,
    distAlongM: view?.trip?.distAlongM ?? null,
    nextStop: view?.stops.find((s) => s.seq === view.trip?.nextStopSeq)?.name ?? null,
  });
}
