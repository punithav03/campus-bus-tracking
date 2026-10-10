import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getNetwork } from '@/lib/network';
import { ensureLive } from '@/lib/live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Is this instance actually working?
 *
 * Public on purpose — the host calls it before any user exists, and a health
 * check that needs a login is a health check that always fails. It reveals
 * nothing: a count of routes and whether the database answered.
 *
 * It genuinely touches the database rather than just returning 200. A process
 * that is running but cannot reach Postgres serves 500s to every student, and
 * a health check that cannot tell those apart is worse than none — it keeps
 * a broken instance in rotation.
 */
export async function GET() {
  const started = Date.now();
  try {
    const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM routes');
    const routes = getNetwork().routes.length;
    // Starts the heartbeat and alert sweep on a cold instance, so the first
    // thing the host does after a deploy also brings the app fully up.
    void ensureLive();
    return NextResponse.json(
      {
        ok: true,
        routes,
        dbRoutes: Number(row?.n ?? 0),
        dbMs: Date.now() - started,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message.slice(0, 120) },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
