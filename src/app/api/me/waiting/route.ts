import { NextResponse } from 'next/server';
import { sql, one } from '@/lib/db';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * "I'm at the stop."
 *
 * One tap from a student, a count for the driver. It exists because of a
 * failure the GPS cannot see: a driver glances at a stop, sees nobody
 * standing in the obvious place, and keeps going — while three students wait
 * under the shelter twenty metres back.
 *
 * Deliberately crude. No history, no identity shown to the driver, and the
 * row expires: it is a statement about right now, and an hour later it is a
 * lie. The driver sees "3 waiting at Pudi Gate", never who.
 */
export async function POST(req: Request) {
  const g = await requireSession(req, ['student']);
  if (!g.ok) return g.res;

  const me = await one<{ route_id: string | null; stop_id: string | null }>(
    'SELECT route_id, stop_id FROM students WHERE roll_no = $1', [g.session.sub]);
  if (!me?.route_id || !me.stop_id) {
    return NextResponse.json({ error: 'Choose your boarding point first.' }, { status: 400 });
  }

  await sql(
    `INSERT INTO waiting (roll_no, route_id, stop_id, at) VALUES ($1,$2,$3, now())
     ON CONFLICT (roll_no) DO UPDATE SET
       route_id = EXCLUDED.route_id, stop_id = EXCLUDED.stop_id, at = now()`,
    [g.session.sub, me.route_id, me.stop_id],
  );
  return NextResponse.json({ ok: true, until: Date.now() + 45 * 60_000 });
}

export async function DELETE(req: Request) {
  const g = await requireSession(req, ['student']);
  if (!g.ok) return g.res;
  await sql('DELETE FROM waiting WHERE roll_no = $1', [g.session.sub]);
  return NextResponse.json({ ok: true });
}

/** Am I currently marked as waiting? */
export async function GET(req: Request) {
  const g = await requireSession(req, ['student']);
  if (!g.ok) return g.res;
  const row = await one<{ at: string }>(
    `SELECT at FROM waiting WHERE roll_no = $1 AND at > now() - interval '45 minutes'`,
    [g.session.sub]);
  return NextResponse.json({ waiting: !!row },
    { headers: { 'Cache-Control': 'no-store' } });
}
