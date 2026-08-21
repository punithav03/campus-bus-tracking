import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { getNetwork } from '@/lib/network';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const net = getNetwork();
    const routes = net.routes.map((r) => {
      const view = engine.view(r.id);
      return {
        ...r,
        live: view?.trip
          ? {
              confidence: view.trip.confidence,
              progress: view.trip.progress,
              delayS: view.trip.delayS,
              lat: view.trip.lat,
              lng: view.trip.lng,
              bearing: view.trip.bearing,
              replaying: engine.isReplaying(r.id),
            }
          : null,
      };
    });
    return NextResponse.json({ campus: net.campus, routes });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
