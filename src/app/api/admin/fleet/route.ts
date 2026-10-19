import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Drivers and student counts, for the transport office only. */
export async function GET(req: Request) {
  const g = await requireSession(req, ['admin']);
  if (!g.ok) return g.res;

  const drivers = await sql<{ id: string; name: string; phone: string; route_id: string | null }>(
    'SELECT id, name, phone, route_id FROM drivers WHERE active ORDER BY route_id',
  );
  const counts = await sql<{ route_id: string; n: string }>(
    'SELECT route_id, count(*) AS n FROM students WHERE route_id IS NOT NULL GROUP BY route_id',
  );

  // Students whose bus or stop came from a guess the office should confirm:
  // a pickup point not on the timetable, a spelling read one way, a stop not
  // found at all. The list is the office's to-do, so it is short and specific.
  const review = await sql<{ roll_no: string; name: string; route_id: string | null; pickup_text: string | null; review: string; stop: string | null }>(
    `SELECT st.roll_no, st.name, st.route_id, st.pickup_text, st.review, s.name AS stop
       FROM students st LEFT JOIN stops s ON s.id = st.stop_id
      WHERE st.review IS NOT NULL ORDER BY st.route_id, st.pickup_text, st.name`,
  );
  const unassigned = await sql<{ route_id: string | null; n: string }>(
    'SELECT route_id, count(*) AS n FROM students WHERE stop_id IS NULL GROUP BY route_id',
  );

  const studentsByRoute: Record<string, number> = {};
  for (const c of counts) studentsByRoute[c.route_id] = Number(c.n);

  return NextResponse.json(
    {
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, phone: d.phone, routeId: d.route_id })),
      studentsByRoute,
      review: review.map((r) => ({
        roll: r.roll_no, name: r.name, routeId: r.route_id, pickup: r.pickup_text, stop: r.stop, note: r.review,
      })),
      noStopByRoute: Object.fromEntries(unassigned.map((u) => [u.route_id ?? '', Number(u.n)])),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
