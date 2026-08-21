import { NextResponse } from 'next/server';
import { checkPin, unauthorized } from '@/lib/auth';
import { engine } from '@/lib/engine';
import { getReferenceTrip, getRoute } from '@/lib/network';

export const dynamic = 'force-dynamic';

/** Start / end a live trip, or drive one from the recorded reference trace. */
export async function POST(req: Request) {
  if (!checkPin(req)) return unauthorized();
  const { routeId, action, speed = 10 } = (await req.json()) as {
    routeId?: string;
    action?: 'start' | 'end' | 'replay' | 'stop-replay';
    speed?: number;
  };

  if (!routeId || !getRoute(routeId)) {
    return NextResponse.json({ error: 'unknown route' }, { status: 404 });
  }

  switch (action) {
    case 'start':
      engine.start(routeId);
      return NextResponse.json({ ok: true, status: 'started' });

    case 'end':
      engine.end(routeId);
      return NextResponse.json({ ok: true, status: 'ended' });

    case 'replay': {
      const ref = getReferenceTrip(routeId);
      if (!ref) return NextResponse.json({ error: 'no reference trip' }, { status: 404 });
      engine.startReplay(routeId, ref.points, Math.max(1, Math.min(60, speed)));
      return NextResponse.json({ ok: true, status: 'replaying', speed, points: ref.points.length });
    }

    case 'stop-replay':
      engine.stopReplay(routeId);
      return NextResponse.json({ ok: true, status: 'stopped' });

    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
