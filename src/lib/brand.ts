import type { Role } from './session';

/**
 * The colour a route is drawn in, for whoever is looking.
 *
 * Each of the nine buses has its own colour, but that only helps someone who
 * sees several of them at once: the transport office, telling buses apart on
 * the fleet screen and the map. A student or a driver only ever sees their own
 * bus, so they all get the app's own orange, the colour the first route had.
 * One look for everyone who rides; a key for the office.
 */
export const BRAND_ROUTE_COLOR = '#f97316';

export function routeColorFor(role: Role | null | undefined, color: string): string {
  return role === 'admin' ? color : BRAND_ROUTE_COLOR;
}
