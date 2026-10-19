import type maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

/**
 * Our own basemap, served from this app — no tile server, no API key, no limit.
 *
 * public/maps/ holds one PMTiles file with the whole bus area (Tirupati,
 * Chittoor, Nagari, Srikalahasti, Nagalapuram, every village between) cut from
 * the Protomaps planet build, plus the fonts and icons it is drawn with. The
 * browser reads the file in small byte ranges, one per tile, straight from our
 * own server; the service worker keeps a full copy on the phone after the first
 * visit, so the map draws with no signal at all.
 *
 * Refresh it each semester (new roads get mapped):
 *   pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
 *     public/maps/svpcet-<YYYYMMDD>.pmtiles --bbox=78.95,13.05,79.95,13.90
 * then update MAP_FILE below. A new name is a new URL, so no cache can serve
 * the old file by mistake.
 */
export const MAP_FILE = '/maps/svpcet-20261018.pmtiles';

/** The area the file covers, [west, south, east, north]. */
export const MAP_BOUNDS: [number, number, number, number] = [78.95, 13.05, 79.95, 13.9];

let registered = false;

/** Teaches MapLibre the pmtiles:// scheme. Safe to call more than once. */
export function registerPmtiles(ml: typeof maplibregl) {
  if (registered) return;
  const protocol = new Protocol();
  ml.addProtocol('pmtiles', protocol.tile);
  registered = true;
}

export function campusStyle(dark: boolean): StyleSpecification {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return {
    version: 8,
    glyphs: `${origin}/maps/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/maps/sprites/${dark ? 'dark' : 'light'}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${origin}${MAP_FILE}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor(dark ? 'dark' : 'light'), { lang: 'en' }) as StyleSpecification['layers'],
  };
}

/** Is the map file reachable (or on the phone already)? */
export async function campusMapReachable(): Promise<boolean> {
  try {
    const r = await fetch(MAP_FILE, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(6000) });
    return r.status === 206 || r.status === 200;
  } catch {
    return false;
  }
}
