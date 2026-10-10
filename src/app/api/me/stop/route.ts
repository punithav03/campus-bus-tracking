import { NextResponse } from 'next/server';
import { one, sql } from '@/lib/db';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface StopRow {
  id: string; name: string; seq: number;
  sched_offset_s: number; estimated: boolean;
}

/** '07:20' + 2700s → '08:05' */
function clockPlus(start: string, offsetS: number): string {
  const [h, m] = start.split(':').map(Number);
  const total = (h * 60 + m) * 60 + offsetS;
  const hh = Math.floor(total / 3600) % 24;
  const mm = Math.floor((total % 3600) / 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * The stops on this student's own route. Nothing else exists as far as this
 * endpoint is concerned.
 *
 * The route is read from the signed session and is NOT a parameter. A student
 * belongs to the bus the transport office put them on; letting them move
 * themselves would make route_id student-asserted, and route_id is what every
 * other authorisation decision in the app rests on.
 *
 * Every option carries its own pickup time, so the picker shows the
 * consequence of the choice rather than a bare list of village names.
 */
export async function GET(req: Request) {
  const g = requireSession(req, ['student']);
  if (!g.ok) return g.res;

  const routeId = g.session.routeId;
  if (!routeId) return NextResponse.json({ stops: [] });

  const route = await one<{ code: string; name: string; color: string; sched_start: string }>(
    'SELECT code, name, color, sched_start FROM routes WHERE id = $1', [routeId],
  );
  const stops = await sql<StopRow>(
    `SELECT id, name, seq, sched_offset_s, estimated
       FROM stops WHERE route_id = $1 ORDER BY seq`, [routeId],
  );

  const start = route?.sched_start ?? '07:00';
  const me = await one<{ stop_id: string | null }>(
    'SELECT stop_id FROM students WHERE roll_no = $1', [g.session.sub],
  );

  return NextResponse.json(
    {
      current: me?.stop_id ?? null,
      route: route && { id: routeId, code: route.code, name: route.name, color: route.color },
      stops: stops.map((s) => ({
        id: s.id,
        name: s.name,
        seq: s.seq,
        estimated: s.estimated,
        pickup: clockPlus(start, s.sched_offset_s),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Saving the choice.
 *
 * The stop must be on the student's own route, checked against the database.
 * The route itself is never taken from the request, so there is no shape of
 * payload that moves a student to another bus.
 */
export async function POST(req: Request) {
  const g = requireSession(req, ['student']);
  if (!g.ok) return g.res;

  const routeId = g.session.routeId;
  if (!routeId) {
    return NextResponse.json(
      { error: 'No bus route is assigned to your account — contact the transport office.' },
      { status: 400 },
    );
  }

  let stopId = '';
  try {
    stopId = String((await req.json())?.stopId ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  }

  const stop = await one<{ route_id: string }>(
    'SELECT route_id FROM stops WHERE id = $1', [stopId],
  );
  if (!stop) return NextResponse.json({ error: 'Unknown stop.' }, { status: 400 });
  if (stop.route_id !== routeId) {
    return NextResponse.json({ error: 'That stop is not on your route.' }, { status: 400 });
  }

  // Only the stop. The route is not in this statement at all.
  await sql('UPDATE students SET stop_id = $2 WHERE roll_no = $1', [g.session.sub, stopId]);

  return NextResponse.json({ ok: true, routeId, stopId });
}
