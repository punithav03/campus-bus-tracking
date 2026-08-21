import { NextResponse } from 'next/server';
import { getRoute } from '@/lib/network';

/** Static route geometry — safe to cache hard, it only changes when you reseed. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const route = getRoute(id);
  if (!route) return NextResponse.json({ error: 'unknown route' }, { status: 404 });

  const { cum, profile, ...rest } = route;
  return NextResponse.json(rest, {
    headers: {
      // NOT a long max-age. This payload changes whenever the route is
      // re-seeded, and a cached copy means the browser keeps drawing yesterday's
      // road — which looks exactly like the seeder failing to fix anything.
      // Revalidate every time; the file is a few KB and rarely changes.
      'Cache-Control': 'no-cache',
    },
  });
}
