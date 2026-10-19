import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/guard';
import { markDismissed } from '@/lib/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The service worker reports that the student swiped the bus card away.
 * From then on that trip only interrupts them for what matters: the bus about
 * to reach their stop, and the college arrival.
 */
export async function POST(req: Request) {
  const g = await requireSession(req, ['student']);
  if (!g.ok) return g.res;
  let tag = '';
  try { tag = String((await req.json())?.tag ?? ''); } catch { /* empty body */ }
  const m = /^bus-(\d{1,12})$/.exec(tag);
  if (!m) return NextResponse.json({ ok: true, ignored: true });
  await markDismissed(Number(m[1]), g.session.sub);
  return NextResponse.json({ ok: true });
}
