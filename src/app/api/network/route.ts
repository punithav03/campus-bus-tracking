import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { getNetwork, engineKey } from '@/lib/network';
import { directionNow } from '@/lib/trip-store';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The routes this account is allowed to know about.
 *
 * A student gets an array of exactly one. Not a list with the others hidden in
 * the UI — a list that never contained them, so the other drivers' numbers and
 * positions are not sitting in a response waiting to be found in devtools.
 */
export async function GET(req: Request) {
  const g = requireSession(req);
  if (!g.ok) return g.res;

  try {
    const net = getNetwork();
    const mine = g.session.role === 'admin'
      ? net.routes
      : net.routes.filter((r) => r.id === g.session.routeId);

    // Which bus "route 2" means depends on the time of day — the morning run
    // and the run home are separate trips on separate lines through the same
    // villages. Looking only at the outbound key is why the fleet screen
    // showed a route as live while offering to start a demo on it.
    const direction = directionNow();
    const routes = mine.map((r) => {
      const key = engineKey(r.id, direction);
      const view = engine.view(key) ?? engine.view(r.id);
      const liveKey = engine.view(key) ? key : r.id;
      // LIVE has to mean "we know where it is now". 'estimated' means the
      // engine is carrying the bus forward on its last known speed because
      // nothing has reported in — honest for a marker, a lie for a badge.
      const running = !!view?.trip
        && view.trip.status === 'running'
        && (view.trip.confidence === 'live' || view.trip.confidence === 'recent');
      // When it gets to the end of the line. The office cares about arrival
      // times, not percentages — "arrives 09:12" is something you can ring
      // somebody about; "32% of route" is not.
      const last = view?.stops[view.stops.length - 1];
      const etaEndS = running && last && !last.passed ? last.etaS : null;

      return {
        ...r,
        live: running && view?.trip
          ? {
              confidence: view.trip.confidence,
              progress: view.trip.progress,
              delayS: view.trip.delayS,
              etaEndS,
              endName: last?.name ?? null,
              arrivedAt: last?.arrivedAt ?? null,
              nextStop: view.stops.find((x) => x.seq === view.trip!.nextStopSeq)?.name ?? null,
              distAlongM: view.trip.distAlongM,
              lat: view.trip.lat,
              lng: view.trip.lng,
              bearing: view.trip.bearing,
              replaying: engine.isReplaying(liveKey),
            }
          : null,
      };
    });

    return NextResponse.json(
      { campus: net.campus, routes, role: g.session.role },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
