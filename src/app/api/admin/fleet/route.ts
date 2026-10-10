import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Drivers and student counts, for the transport office only. */
export async function GET(req: Request) {
  const g = requireSession(req, ['admin']);
  if (!g.ok) return g.res;

  const drivers = await sql<{ id: string; name: string; phone: string; route_id: string | null }>(
    'SELECT id, name, phone, route_id FROM drivers WHERE active ORDER BY route_id',
  );
  const counts = await sql<{ route_id: string; n: string }>(
    'SELECT route_id, count(*) AS n FROM students WHERE route_id IS NOT NULL GROUP BY route_id',
  );

  const studentsByRoute: Record<string, number> = {};
  for (const c of counts) studentsByRoute[c.route_id] = Number(c.n);

  return NextResponse.json(
    {
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, phone: d.phone, routeId: d.route_id })),
      studentsByRoute,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
