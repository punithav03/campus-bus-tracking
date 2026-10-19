import { NextResponse } from 'next/server';
import { one } from '@/lib/db';
import { requireSession } from '@/lib/guard';
import { sendTest } from '@/lib/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * "Send a test": one sample bus card to every device this student signed up.
 * Rate-limited by nature of being a button; the push services throttle abuse.
 */
export async function POST(req: Request) {
  const g = requireSession(req, ['student']);
  if (!g.ok) return g.res;
  const me = await one<{ route: string | null; stop: string | null }>(
    `SELECT r.name AS route, s.name AS stop
       FROM students st LEFT JOIN routes r ON r.id = st.route_id LEFT JOIN stops s ON s.id = st.stop_id
      WHERE st.roll_no = $1`, [g.session.sub],
  );
  const routeName = (me?.route ?? 'Your bus').replace(/\s+—\s+Campus$/, ' Bus');
  const sent = await sendTest(g.session.sub, routeName, me?.stop ?? null);
  if (!sent) {
    return NextResponse.json({ error: 'No device is signed up for notifications yet.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, sent });
}
