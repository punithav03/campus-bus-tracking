import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireSession } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Remove one student.
 *
 * Exists so the automated checks can clear up the accounts they create — a
 * test suite that leaves rows behind quietly inflates every count on the
 * fleet screen until someone notices route 3 has seventeen students.
 * Admin only, like everything else under /api/admin.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ roll: string }> },
) {
  const g = requireSession(req, ['admin']);
  if (!g.ok) return g.res;

  const { roll } = await params;
  const rows = await sql<{ roll_no: string }>(
    'DELETE FROM students WHERE roll_no = $1 RETURNING roll_no', [roll],
  );
  return NextResponse.json({ ok: true, deleted: rows.length });
}
