import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/guard';
import { openAlerts } from '@/lib/alerts';
import { ensureLive } from '@/lib/live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** What is wrong this morning. Empty most days, which is the point. */
export async function GET(req: Request) {
  const g = requireSession(req, ['admin']);
  if (!g.ok) return g.res;
  await ensureLive();
  return NextResponse.json({ alerts: await openAlerts() },
    { headers: { 'Cache-Control': 'no-store' } });
}
