/**
 * Pins the route's stops to real OpenStreetMap villages.
 *
 * Nominatim's search index skips many small Andhra villages, so this queries
 * raw OSM data through Overpass instead: every place node in a box around the
 * route, then fuzzy-matched against the stop names the college gave us.
 *
 *   node scripts/find-villages.mjs
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'osm-places.json');

// Box covering Nagalapuram in the east through Puttur in the west.
const BBOX = [13.26, 79.46, 13.54, 79.92]; // south, west, north, east

const TARGETS = [
  'Nagalapuram', 'Indira Nagar', 'Krishnapuram', 'Ramagiri', 'Appambattu',
  'Pichatur', 'Nindra', 'Koppedu', 'Palamangalam', 'Thumburu',
  'Chittoor Kandriga', 'Kailasakona', 'Vettalataduku', 'Narayanavanam', 'Puttur',
];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchPlaces() {
  if (existsSync(CACHE)) {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`· ${cached.length} places from cache`);
    return cached;
  }
  const query = `[out:json][timeout:90];
(
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|isolated_dwelling)$"](${BBOX.join(',')});
);
out body;`;

  for (const url of ENDPOINTS) {
    try {
      process.stdout.write(`· querying ${new URL(url).host} … `);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'CampusBusTracker/0.1 (student project; local use)',
          Accept: '*/*',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(text);
      const places = json.elements.map((e) => ({
        name: e.tags?.name ?? '',
        alt: e.tags?.['name:en'] ?? e.tags?.alt_name ?? '',
        place: e.tags?.place,
        lat: e.lat,
        lng: e.lon,
      })).filter((p) => p.name);
      console.log(`${places.length} places`);
      writeFileSync(CACHE, JSON.stringify(places));
      return places;
    } catch (err) {
      console.log(`failed (${err.message})`);
    }
  }
  throw new Error('every Overpass endpoint failed');
}

// ---- fuzzy matching -------------------------------------------------------

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Levenshtein, capped — village names get transliterated many different ways. */
function distance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Telugu place names share endings constantly — -puram, -kandriga, -palli. Plain
 * edit distance therefore rates "Samayapuram" against "Vijayapuram" at 73%, and
 * "Keelapudi" against "Arunanaga" at 78%, both of which are different villages
 * entirely. So weight the START of the name heavily: that is where the actual
 * identity lives, and a shared suffix proves nothing.
 */
function score(target, candidate) {
  const t = norm(target), c = norm(candidate);
  if (!t || !c) return 0;
  if (t === c) return 1;

  // A compound like "Koppedu Acharyula Kandriga" may be mapped under one word.
  if (t.includes(c) && c.length >= 6) return 0.9;
  if (c.includes(t) && t.length >= 6) return 0.9;

  const full = 1 - distance(t, c) / Math.max(t.length, c.length);
  const k = Math.min(5, t.length, c.length);
  const prefix = 1 - distance(t.slice(0, k), c.slice(0, k)) / k;
  return 0.6 * full + 0.4 * prefix;
}

const ACCEPT = 0.78;

/** Straight-line metres — used only to break ties between same-named villages. */
function metres(a, b) {
  const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const places = await fetchPlaces();
console.log('');

// Pass 1 — rank candidates for every stop.
const ranked = TARGETS.map((target) => ({
  target,
  list: places
    .flatMap((p) => [
      { p, s: score(target, p.name) },
      ...(p.alt ? [{ p, s: score(target, p.alt) }] : []),
    ])
    .filter((r) => r.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5),
}));

// Pass 2 — accept the unambiguous ones: a clear winner with no near-equal rival.
const resolved = {};
for (const { target, list } of ranked) {
  const best = list[0];
  if (!best || best.s < ACCEPT) continue;
  const rival = list.find((r) => r !== best && r.s > best.s - 0.06 && metres(r.p, best.p) > 1500);
  if (!rival) resolved[target] = best.p;
}

// Pass 3 — several villages share a name, so let the ROUTE ORDER decide. The
// college told us the sequence; the right Krishnapuram is the one that actually
// sits between the stops on either side of it.
for (const { target, list } of ranked) {
  if (resolved[target] || !list.length || list[0].s < ACCEPT) continue;
  const i = TARGETS.indexOf(target);
  const before = TARGETS.slice(0, i).reverse().map((t) => resolved[t]).find(Boolean);
  const after = TARGETS.slice(i + 1).map((t) => resolved[t]).find(Boolean);
  const anchors = [before, after].filter(Boolean);
  if (!anchors.length) continue;

  const expected = anchors.length === 2
    ? { lat: (before.lat + after.lat) / 2, lng: (before.lng + after.lng) / 2 }
    : anchors[0];

  const top = list.filter((r) => r.s > list[0].s - 0.06);
  top.sort((a, b) => metres(a.p, expected) - metres(b.p, expected));
  resolved[target] = top[0].p;
  resolved[target]._byOrder = Math.round(metres(top[0].p, expected));
}

for (const { target, list } of ranked) {
  console.log(target);
  if (!list.length) { console.log('     nothing above 50% — not in OpenStreetMap\n'); continue; }
  for (const r of list.slice(0, 3)) {
    const chosen = resolved[target] === r.p;
    console.log(
      `${chosen ? '  ✓' : '   '} ${(r.s * 100).toFixed(0).padStart(3)}%  ` +
      `${r.p.name.padEnd(28)}${r.p.lat.toFixed(5)}, ${r.p.lng.toFixed(5)}  (${r.p.place})` +
      `${chosen && r.p._byOrder != null ? `  ← chosen by route order` : ''}`,
    );
  }
  if (!resolved[target]) console.log('     rejected — best match is below the confidence bar');
  console.log('');
}

console.log('--- paste-ready ---');
for (const t of TARGETS) {
  const r = resolved[t];
  console.log(
    r
      ? `      { name: '${t}', lat: ${r.lat.toFixed(5)}, lng: ${r.lng.toFixed(5)} },`
      : `      { name: '${t}' },   // still not in OSM`,
  );
}
