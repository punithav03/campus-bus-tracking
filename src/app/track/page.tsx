import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getRoute, getNetwork } from '@/lib/network';
import { currentRouteId } from '@/lib/guard';
import { routeColorFor } from '@/lib/brand';
import { TrackClient } from './TrackClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The map page, assembled on the server.
 *
 * The route is static data that already lives in this repo — 1,310 points of
 * road that have not changed since the day they were seeded. Fetching it from
 * the browser after the page loaded was pure waste: it put a network round
 * trip, a spinner and a failure mode in front of something we could simply
 * have printed into the HTML.
 *
 * So we read it here, on the server, where the file is already in memory, and
 * hand it to the client as a prop. The line is in the first painted frame.
 * There is no loading state to see, nothing to retry, and nothing to go wrong
 * on a village signal.
 *
 * Authorisation happens here too, which is better than it was: an unsigned
 * visitor is redirected before any HTML is built, rather than being shown a
 * skeleton that disappears a moment later.
 */
export default async function TrackPage({
  searchParams,
}: {
  searchParams: Promise<{ route?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  // Home is where a first password gets replaced; nothing else opens before.
  if (session.mustChangePassword && session.role !== 'admin') redirect('/');

  const net = getNetwork();
  // Admins have no route of their own. They can name one — that is how the
  // fleet screen opens a particular bus — and otherwise get the first.
  // Everyone else is pinned to their own; the parameter is ignored, not
  // validated, so there is no path where it can move a student's bus.
  const asked = (await searchParams)?.route;
  const routeId = session.role === 'admin'
    ? (net.routes.some((r) => r.id === asked) ? asked! : net.routes[0]?.id ?? null)
    : await currentRouteId(session);
  // Removed or deactivated since signing in: sign in again.
  if (routeId === undefined) redirect('/login');
  const route = routeId ? getRoute(routeId) : null;

  // cum and profile are server-side engine internals — hundreds of kilobytes
  // the browser has no use for.
  const initialRoute = route
    ? {
        id: route.id,
        color: routeColorFor(session.role, route.color),
        shape: route.shape,
        stops: route.stops.map((s) => ({
          id: s.id, name: s.name, lat: s.lat, lng: s.lng, estimated: s.estimated,
        })),
      }
    : null;

  return <TrackClient initialRoute={initialRoute} initialCampus={net.campus} />;
}
