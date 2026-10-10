import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { sql, tx } from '@/lib/db';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Bulk student import, from the college's own list.
 *
 * There is deliberately no button for this in the app. The college sends us
 * the roster and we load it from here, so the admin screen stays what the
 * transport office actually needs — a view of the buses — rather than a data
 * entry tool nobody there was going to use.
 *
 * This is the only way a student account comes into existence. There is no
 * self-registration, deliberately: route_id is what every authorisation
 * decision in the app rests on, and it is only trustworthy because a human in
 * the transport office put it there.
 *
 * The whole file is validated BEFORE anything is written, and the write is one
 * transaction. A half-imported list — three hundred students in, two hundred
 * missing, nobody sure which — is far worse to recover from than a rejection
 * with the bad line numbers in it.
 */

interface Row { rollNo: string; name: string; routeId: string; stopId: string }

export async function POST(req: Request) {
  const g = requireSession(req, ['admin']);
  if (!g.ok) return g.res;

  let csv = '';
  try {
    csv = String((await req.json())?.csv ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  }
  if (!csv.trim()) return NextResponse.json({ error: 'The file is empty.' }, { status: 400 });

  const routes = new Set((await sql<{ id: string }>('SELECT id FROM routes')).map((r) => r.id));
  const stops = new Map(
    (await sql<{ id: string; route_id: string }>('SELECT id, route_id FROM stops'))
      .map((s) => [s.id, s.route_id]),
  );

  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Tolerate a header row, because every spreadsheet export has one.
  if (/roll/i.test(lines[0] ?? '')) lines.shift();

  const rows: Row[] = [];
  const errors: string[] = [];

  lines.forEach((line, i) => {
    const n = i + 1;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 4) { errors.push(`Line ${n}: needs 4 columns`); return; }

    const [rollNo, name, routeId, stopId] = cols;
    if (!rollNo) { errors.push(`Line ${n}: no roll number`); return; }
    if (!name) { errors.push(`Line ${n}: no name`); return; }
    if (!routes.has(routeId)) { errors.push(`Line ${n}: unknown route "${routeId}"`); return; }
    if (!stops.has(stopId)) { errors.push(`Line ${n}: unknown stop "${stopId}"`); return; }
    if (stops.get(stopId) !== routeId) {
      errors.push(`Line ${n}: ${stopId} is not on ${routeId}`); return;
    }
    rows.push({ rollNo, name, routeId, stopId });
  });

  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.rollNo.toUpperCase();
    if (seen.has(key)) errors.push(`${r.rollNo} appears twice in the file`);
    seen.add(key);
  }

  if (errors.length) {
    return NextResponse.json(
      { error: `${errors.length} problem${errors.length > 1 ? 's' : ''} — nothing was imported.`,
        details: errors.slice(0, 25) },
      { status: 400 },
    );
  }

  // All or nothing.
  const result = await tx(async (q) => {
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const out = await q<{ created: boolean }>(
        `INSERT INTO students (roll_no, name, password_hash, route_id, stop_id, must_change_password)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (roll_no) DO UPDATE SET
           name = EXCLUDED.name, route_id = EXCLUDED.route_id, stop_id = EXCLUDED.stop_id
         RETURNING (xmax = 0) AS created`,
        // The temporary password is the roll number. PasswordGate makes them
        // replace it before they can reach any screen.
        [r.rollNo, r.name, bcrypt.hashSync(r.rollNo, 10), r.routeId, r.stopId],
      );
      if (out[0]?.created) created++; else updated++;
    }
    return { created, updated };
  });

  return NextResponse.json({ ok: true, total: rows.length, ...result });
}
