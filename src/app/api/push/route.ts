import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireSession } from '@/lib/guard';
import { pushConfigured } from '@/lib/push';
import { ensureLive } from '@/lib/live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Is push available, and is this device already signed up? */
export async function GET(req: Request) {
  const g = requireSession(req, ['student']);
  if (!g.ok) return g.res;
  void ensureLive();

  const rows = await sql<{ endpoint: string; lead_min: number }>(
    'SELECT endpoint, lead_min FROM push_subscriptions WHERE roll_no = $1', [g.session.sub],
  );
  return NextResponse.json(
    {
      available: pushConfigured(),
      publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null,
      devices: rows.length,
      leadMin: rows[0]?.lead_min ?? 5,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Registers a device.
 *
 * Keyed on the endpoint, not the student: the same person on a phone and a
 * laptop should be told on both, and revoking one must not silence the other.
 * Re-subscribing with the same endpoint just refreshes the keys, which is what
 * happens when a browser rotates them.
 */
export async function POST(req: Request) {
  const g = requireSession(req, ['student']);
  if (!g.ok) return g.res;

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; leadMin?: number };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  }

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: 'Incomplete subscription.' }, { status: 400 });
  }

  const lead = Math.max(1, Math.min(30, Number(body.leadMin ?? 5) || 5));
  await sql(
    `INSERT INTO push_subscriptions (endpoint, roll_no, p256dh, auth, lead_min, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint) DO UPDATE SET
       roll_no = EXCLUDED.roll_no, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, lead_min = EXCLUDED.lead_min, failures = 0`,
    [endpoint, g.session.sub, keys.p256dh, keys.auth, lead,
     (req.headers.get('user-agent') ?? '').slice(0, 200)],
  );
  void ensureLive();
  return NextResponse.json({ ok: true, leadMin: lead });
}

/** Turning them off, for this device or all of them. */
export async function DELETE(req: Request) {
  const g = requireSession(req, ['student']);
  if (!g.ok) return g.res;

  let endpoint: string | null = null;
  try { endpoint = (await req.json())?.endpoint ?? null; } catch { /* all of them */ }

  if (endpoint) await sql('DELETE FROM push_subscriptions WHERE endpoint = $1 AND roll_no = $2',
    [endpoint, g.session.sub]);
  else await sql('DELETE FROM push_subscriptions WHERE roll_no = $1', [g.session.sub]);

  return NextResponse.json({ ok: true });
}
