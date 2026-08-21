import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/**
 * The single endpoint every student device polls.
 *
 * In production this response is what you would write to object storage every
 * few seconds and serve from a CDN — one origin write regardless of whether ten
 * students or ten thousand are watching. Polling a cached snapshot scales for
 * free; a WebSocket per student does not.
 */
export async function GET(req: Request) {
  const routeId = new URL(req.url).searchParams.get('route');
  if (!routeId) return NextResponse.json({ error: 'route required' }, { status: 400 });

  const view = engine.view(routeId);
  if (!view) return NextResponse.json({ error: 'unknown route' }, { status: 404 });

  return NextResponse.json(
    { ...view, replaying: engine.isReplaying(routeId) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
