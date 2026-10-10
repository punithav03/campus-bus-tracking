import { NextResponse } from 'next/server';
import { getRoute } from '@/lib/network';
import { requireSession } from '@/lib/guard';

/**
 * Route geometry — the road line and the stop list for one route.
 *
 * Gated like everything else. The shape of a public road is hardly a secret,
 * but the stop list tells you where a particular bus picks up children, and
 * there is no reason to serve that to someone who is not on the route.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = requireSession(req);
  if (!g.ok) return g.res;

  const { id } = await params;
  if (g.session.role !== 'admin' && id !== g.session.routeId) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const route = getRoute(id);
  if (!route) return NextResponse.json({ error: 'unknown route' }, { status: 404 });

  const { cum, profile, ...rest } = route;
  return NextResponse.json(rest, {
    headers: {
      // NOT a long max-age. This payload changes whenever the route is
      // re-seeded, and a cached copy means the browser keeps drawing
      // yesterday's road — which looks exactly like the seeder failing to fix
      // anything. Private, because the answer now depends on who asked.
      'Cache-Control': 'private, no-cache',
    },
  });
}
