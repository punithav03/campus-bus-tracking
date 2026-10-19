import { NextResponse } from 'next/server';
import { requireRoute } from '@/lib/guard';
import { engine } from '@/lib/engine';
import { getRoute } from '@/lib/network';
import { openTrip, closeTrip, directionNow } from '@/lib/trip-store';
import { demoTrace } from '@/lib/demo-run';
import { ensureLive } from '@/lib/live';
import { one } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Start or end a run. One route, one direction: village to campus. */
export async function POST(req: Request) {
  const g = await requireRoute(req, ['driver', 'admin']);
  if (!g.ok) return g.res;
  await ensureLive();

  let body: { action?: string; speed?: number; skipSpur?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'malformed request body' }, { status: 400 });
  }

  const routeId = g.routeId!;
  const { speed = 10 } = body ?? {};
  const action = body?.action as 'start' | 'end' | 'replay' | 'stop-replay' | undefined;

  if ((action === 'replay' || action === 'stop-replay') && g.session.role !== 'admin') {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }
  const direction = directionNow();
  const key = routeId;

  if (!getRoute(key)) {
    return NextResponse.json({ error: 'unknown route' }, { status: 404 });
  }

  switch (action) {
    case 'start': {
      const driverId = g.session.role === 'driver' ? g.session.sub : null;
      // The database row comes first and owns the id, so a restart can find
      // this trip again. The engine is the fast copy, not the record.
      const row = await openTrip(routeId, direction, driverId, key);
      const trip = engine.start(key);
      trip.id = String(row.id);
      return NextResponse.json({ ok: true, status: 'started', direction, tripId: row.id });
    }

    case 'end': {
      const view = engine.view(key);
      const id = Number(view?.trip?.id);
      engine.end(key);
      if (Number.isFinite(id)) await closeTrip(id, 'finished');

      // What the driver sees when he stops: not a blank screen, a run.
      const summary = Number.isFinite(id)
        ? await one<{ stops: string; first: string | null; last: string | null; avg: string | null }>(
            `SELECT count(*) FILTER (WHERE NOT skipped) AS stops,
                    min(reached_at)::text AS first,
                    max(reached_at)::text AS last,
                    round(avg(delay_s))::text AS avg
               FROM stop_events WHERE trip_id = $1`, [id])
        : null;

      return NextResponse.json({
        ok: true,
        status: 'ended',
        summary: summary && Number(summary.stops) > 0 ? {
          stops: Number(summary.stops),
          startedAt: summary.first,
          endedAt: summary.last,
          avgDelayS: summary.avg == null ? null : Number(summary.avg),
        } : null,
      });
    }

    // ---- demo run ------------------------------------------------------
    // Showing this app has a chicken-and-egg problem: the thing worth showing
    // is a bus moving, and there is no bus in a meeting room. Route 1 replays
    // a real recorded ride; the others drive their own road line at the
    // timetable's pace. Office only, and it says which kind it is.
    case 'replay': {
      const trace = demoTrace(key, { skipSpur: body?.skipSpur === true });
      if (!trace) return NextResponse.json({ error: 'no route to replay' }, { status: 404 });
      if (body?.skipSpur === true && !trace.cutS) {
        return NextResponse.json({
          error: 'This route has no village it goes out to and back from, so there is nothing to skip.',
        }, { status: 422 });
      }
      engine.startReplay(key, trace.points, Math.max(1, Math.min(120, speed)));
      return NextResponse.json({
        ok: true, status: 'replaying', speed,
        points: trace.points.length, source: trace.source, direction,
        skippedSpurS: trace.cutS ?? null,
      });
    }

    case 'stop-replay': {
      // Stopping the feed is not the same as ending the run. Left as it was,
      // the trip stayed open with its last position frozen, so the fleet
      // screen kept saying LIVE next to a bus that had not moved in ten
      // minutes — and offered to start a demo on it at the same time.
      engine.stopReplay(key);
      const v = engine.view(key);
      const id = Number(v?.trip?.id);
      engine.end(key);
      if (Number.isFinite(id)) await closeTrip(id, 'abandoned');
      return NextResponse.json({ ok: true, status: 'stopped' });
    }

    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
