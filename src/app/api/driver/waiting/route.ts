import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireRoute } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Who is standing at which stop, for the driver of that bus.
 *
 * Counts only — names would be surveillance, and the driver does not need
 * them to decide whether to pull in.
 */
export async function GET(req: Request) {
  const g = requireRoute(req, ['driver', 'admin']);
  if (!g.ok) return g.res;

  const rows = await sql<{ stop_id: string; name: string; n: string; seq: number }>(
    `SELECT w.stop_id, s.name, s.seq, count(*) AS n
       FROM waiting w JOIN stops s ON s.id = w.stop_id
      WHERE w.route_id = $1 AND w.at > now() - interval '45 minutes'
      GROUP BY w.stop_id, s.name, s.seq
      ORDER BY s.seq`,
    [g.routeId],
  );
  return NextResponse.json(
    {
      total: rows.reduce((a, r) => a + Number(r.n), 0),
      stops: rows.map((r) => ({ id: r.stop_id, name: r.name, seq: r.seq, count: Number(r.n) })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
