import { NextResponse } from 'next/server';
import { one, sql } from '@/lib/db';
import { requireSession } from '@/lib/guard';
import { engine } from '@/lib/engine';
import { getRoute, engineKey } from '@/lib/network';
import { directionNow } from '@/lib/trip-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Everything the student's home screen needs, in one request.
 *
 * One round trip rather than four, because this screen is opened at a bus stop
 * on village mobile data and every extra request is a second of staring at a
 * spinner. The driver's phone number is included — but only ever this route's
 * driver, read through the session, so no other driver's number is in the
 * payload to be found.
 */

interface StopRow {
  id: string; name: string; seq: number; dist_along_m: number;
  sched_offset_s: number; estimated: boolean;
}
interface DriverRow { name: string; phone: string }
interface RouteRow { id: string; name: string; code: string; color: string; sched_start: string }

/** '07:20' + 2700s → '08:05' */
function clockPlus(start: string, offsetS: number): string {
  const [h, m] = start.split(':').map(Number);
  const total = (h * 60 + m) * 60 + offsetS;
  const hh = Math.floor(total / 3600) % 24;
  const mm = Math.floor((total % 3600) / 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if (!g.ok) return g.res;
  const { session } = g;

  if (session.role === 'admin') {
    return NextResponse.json({ role: 'admin' }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!session.routeId) {
    return NextResponse.json(
      { role: session.role, route: null,
        message: 'No bus route is assigned to your account — contact the transport office.' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const route = await one<RouteRow>(
    'SELECT id, name, code, color, sched_start FROM routes WHERE id = $1', [session.routeId]);
  const driver = await one<DriverRow>(
    'SELECT name, phone FROM drivers WHERE route_id = $1 AND active LIMIT 1', [session.routeId]);

  // The student's own boarding point. Drivers have no stop of their own.
  let myStop: StopRow | null = null;
  if (session.role === 'student') {
    myStop = await one<StopRow>(
      `SELECT s.id, s.name, s.seq, s.dist_along_m, s.sched_offset_s, s.estimated
         FROM students st JOIN stops s ON s.id = st.stop_id
        WHERE st.roll_no = $1`, [session.sub]);
  }

  const stops = await sql<StopRow>(
    `SELECT id, name, seq, dist_along_m, sched_offset_s, estimated
       FROM stops WHERE route_id = $1 ORDER BY seq`, [session.routeId]);

  const start = route?.sched_start ?? '07:00';
  const lastOffset = stops.length ? stops[stops.length - 1].sched_offset_s : 0;

  // Which bus "my route" means depends on the time of day. The morning run
  // and the run home are separate trips on separate lines through the same
  // villages, and this screen used to look only under the morning key — so
  // an afternoon bus was live on the map and on the fleet screen while the
  // student's own home screen said it was not running.
  const direction = directionNow();
  const key = engineKey(session.routeId, direction);

  // Live position, if the bus is running RIGHT NOW.
  //
  // The engine keeps a trip's view after it finishes — the arrival time and
  // the stop events are still wanted. But "there is a view" is not the same
  // as "there is a bus", and treating the two as equal is what left the home
  // screen showing LIVE, with the road scrolling, half an hour after the run
  // ended. A finished or stale trip is not live.
  const raw = engine.view(key) ?? engine.view(session.routeId);
  const view = raw;
  const isLive = !!raw?.trip
    && raw.trip.status === 'running'
    && (raw.trip.confidence === 'live' || raw.trip.confidence === 'recent');
  const geo = getRoute(key) ?? getRoute(session.routeId);

  let eta: { seconds: number; clock: string; stopsAway: number; passed: boolean } | null = null;
  if (view?.trip && myStop) {
    const hit = view.stops.find((s) => s.id === myStop!.id);
    if (hit) {
      eta = {
        seconds: hit.etaS ?? 0,
        clock: hit.etaS == null ? '' : new Date(Date.now() + hit.etaS * 1000)
          .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
        stopsAway: Math.max(0, myStop.seq - (view.trip.nextStopSeq ?? 0)),
        passed: hit.passed,
      };
    }
  }

  return NextResponse.json(
    {
      role: session.role,
      name: session.name,
      route: route && {
        id: route.id, code: route.code, name: route.name, color: route.color,
        startTime: start,
        stopCount: stops.length,
        lengthKm: geo ? Math.round(geo.lengthM / 100) / 10 : null,
      },
      // Never another route's driver — this row was fetched by the session's
      // own route id and nothing else.
      driver: driver && { name: driver.name, phone: driver.phone },
      boarding: myStop && {
        id: myStop.id,
        name: myStop.name,
        seq: myStop.seq,
        estimated: myStop.estimated,
        pickup: clockPlus(start, myStop.sched_offset_s),
        // Afternoon run: the college leaves at 16:45 and the order reverses,
        // so the stop furthest out is reached last. Scheduled, not measured.
        drop: clockPlus('16:45', lastOffset - myStop.sched_offset_s),
      },
      live: isLive && view?.trip
        ? {
            confidence: view.trip.confidence,
            progress: view.trip.progress,
            delayS: view.trip.delayS,
            nextStop: view.stops.find((s) => s.seq === view.trip!.nextStopSeq)?.name ?? null,
            ageS: view.trip.ageS,
            // Drives the road speed in the artwork, so a crawling bus looks
            // like one rather than cruising.
            speedMps: view.trip.speedMps,
          }
        : null,
      eta,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
