import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { getNetwork } from '@/lib/network';
import { routeColorFor } from '@/lib/brand';
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

    const routes = mine.map((r) => {
      const view = engine.view(r.id);
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
        color: routeColorFor(g.session.role, r.color),
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
              replaying: engine.isReplaying(r.id),
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
