/**
 * Turns a recorded ride into a real route.
 *
 *   npm run import-trace -- rec-1234.json --id route-1 --name "Pichatur — Campus"
 *
 * What it does with your trace:
 *   1. throws out unusable fixes (bad accuracy, impossible jumps, duplicates)
 *   2. simplifies the path into a clean road line
 *   3. finds every place the bus actually stood still — those are your stops
 *   4. keeps any stop you tagged with "Mark stop" and uses your name for it
 *   5. names the rest from OpenStreetMap
 *   6. builds the time-vs-distance profile the ETA model runs on
 *   7. writes a replayable 1 Hz trip so you can demo it anywhere
 *
 * Flags
 *   --id <route-id>      which route to write (default: route-recorded)
 *   --name "..."         display name
 *   --code 1             short code shown in the UI
 *   --color "#f97316"    line colour
 *   --snap               additionally map-match to roads via OSRM (needs internet)
 *   --no-geocode         skip OpenStreetMap stop naming (fully offline)
 *   --min-halt 12        seconds stationary before it counts as a stop
 *   --names-from <id>    reuse that route's stop names instead of OpenStreetMap's
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const UA = { 'User-Agent': 'CampusBusTracker/0.1 (student project; local use)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

if (!file) {
  console.error('usage: npm run import-trace -- <file.json> --id route-1 --name "..."');
  process.exit(1);
}

const ROUTE_ID = flag('id', 'route-recorded');
const CODE = flag('code', ROUTE_ID.replace(/\D/g, '') || 'R');
const COLOR = flag('color', '#f97316');
const MIN_HALT_S = Number(flag('min-halt', 12));
const GEOCODE = !has('no-geocode');
const NAMES_FROM = flag('names-from', null);

// -------------------------------------------------------------------- geo

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const pt = ([lng, lat]) => ({ lng, lat });

function cumulative(shape) {
  const cum = [0];
  for (let i = 1; i < shape.length; i++)
    cum.push(cum[i - 1] + haversine(pt(shape[i - 1]), pt(shape[i])));
  return cum;
}

function atDistance(shape, cum, d) {
  d = Math.max(0, Math.min(cum[cum.length - 1], d));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= d) lo = m; else hi = m;
  }
  const span = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / span;
  return {
    lng: shape[lo][0] + t * (shape[hi][0] - shape[lo][0]),
    lat: shape[lo][1] + t * (shape[hi][1] - shape[lo][1]),
  };
}

function lb(cum, d) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  return lo;
}

function projectOnto(shape, cum, p, lo = null, hi = null) {
  let best = { d2: Infinity, distAlong: lo ?? 0 };
  const from = lo == null ? 1 : Math.max(1, lb(cum, lo));
  const to = hi == null ? shape.length - 1 : Math.min(shape.length - 1, lb(cum, hi) + 1);
  const kLat = 111320, kLng = 111320 * Math.cos(rad(p.lat));
  for (let i = from; i <= to; i++) {
    const [ax, ay] = shape[i - 1], [bx, by] = shape[i];
    const axm = (ax - p.lng) * kLng, aym = (ay - p.lat) * kLat;
    const bxm = (bx - p.lng) * kLng, bym = (by - p.lat) * kLat;
    const dx = bxm - axm, dy = bym - aym;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : -(axm * dx + aym * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = axm + t * dx, cy = aym + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best.d2) best = { d2, distAlong: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
  }
  return best;
}

/** Douglas-Peucker, in metres. Turns thousands of noisy fixes into a clean line. */
function simplify(points, epsM) {
  if (points.length < 3) return points;
  const kLat = 111320;
  const kLng = 111320 * Math.cos(rad(points[0][1]));
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = points[s], [bx, by] = points[e];
    const axm = ax * kLng, aym = ay * kLat, bxm = bx * kLng, bym = by * kLat;
    const dx = bxm - axm, dy = bym - aym;
    const l2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const pxm = points[i][0] * kLng, pym = points[i][1] * kLat;
      let t = l2 === 0 ? 0 : ((pxm - axm) * dx + (pym - aym) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const cx = axm + t * dx, cy = aym + t * dy;
      const d = Math.hypot(pxm - cx, pym - cy);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsM && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// --------------------------------------------------------------- services

async function mapMatch(coords) {
  // OSRM's public /match caps the coordinate count, so send overlapping chunks.
  const CHUNK = 90;
  const out = [];
  for (let start = 0; start < coords.length - 1; start += CHUNK - 1) {
    const slice = coords.slice(start, start + CHUNK);
    if (slice.length < 2) break;
    const path = slice.map(([lng, lat]) => `${lng},${lat}`).join(';');
    const radiuses = slice.map(() => 25).join(';');
    const url =
      `https://router.project-osrm.org/match/v1/driving/${path}` +
      `?overview=full&geometries=geojson&radiuses=${radiuses}&gaps=ignore&tidy=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const j = await res.json();
    if (j.code !== 'Ok' || !j.matchings?.length) throw new Error(`OSRM match ${j.code}`);
    for (const m of j.matchings) out.push(...m.geometry.coordinates);
    await sleep(300);
  }
  return out;
}

const cachePath = join(DATA, 'geocache.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

function isRoadish(s) {
  return (
    /^(NH|SH|MDR|ODR)[\s-]?\d+/i.test(s) ||
    /\b(road|highway|byp?ass|marg|street)\b/i.test(s) ||
    s.includes(' - ') || s.length > 22
  );
}

async function placeName(lat, lng, taken) {
  const key = `a:${lat.toFixed(4)},${lng.toFixed(4)}`;
  let addr = cache[key];
  if (!addr) {
    if (!GEOCODE) return null;
    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`;
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      addr = (await r.json()).address ?? {};
      cache[key] = addr;
      writeFileSync(cachePath, JSON.stringify(cache));
      await sleep(1100);
    } catch {
      return null;
    }
  }
  const chain = [
    addr.neighbourhood, addr.suburb, addr.hamlet, addr.village,
    addr.town, addr.city_district, addr.city,
  ].filter(Boolean).filter((c) => !isRoadish(c));
  for (const c of chain) if (!taken.has(c)) return c;
  if (chain.length) for (let k = 2; k < 9; k++)
    if (!taken.has(`${chain[0]} ${k}`)) return `${chain[0]} ${k}`;
  return null;
}

// -------------------------------------------------------------------- run

/**
 * Reads a GPX track — what any Android GPS logger exports.
 *
 * This matters more than it sounds: a browser cannot record location in the
 * background on Android, so a ride captured by our own /record page stops the
 * moment the phone is locked. A native logger keeps running with the screen
 * off, and GPX is what it hands back.
 *
 * GPX carries no accuracy figure and usually no speed. Neither is required —
 * downstream, speed is measured over a time window whenever the device does not
 * report it, which is also what makes stop detection work.
 */
function parseGpx(xml) {
  const fixes = [];
  const trkpt = /<(?:trkpt|wpt)\b([^>]*)>([\s\S]*?)<\/(?:trkpt|wpt)>|<(?:trkpt|wpt)\b([^>]*)\/>/g;
  let m;
  while ((m = trkpt.exec(xml)) !== null) {
    const attrs = m[1] ?? m[3] ?? '';
    const body = m[2] ?? '';
    const lat = Number(/\blat\s*=\s*"([^"]+)"/.exec(attrs)?.[1]);
    const lng = Number(/\blon\s*=\s*"([^"]+)"/.exec(attrs)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const timeStr = /<time>([^<]+)<\/time>/.exec(body)?.[1];
    const t = timeStr ? Date.parse(timeStr) : NaN;
    if (!Number.isFinite(t)) continue; // a point with no clock is unusable

    // Speed appears in several places depending on the logger.
    const spdRaw =
      /<speed>([^<]+)<\/speed>/.exec(body)?.[1] ??
      /<(?:\w+:)?speed>([^<]+)<\/(?:\w+:)?speed>/.exec(body)?.[1];
    const accRaw =
      /<(?:\w+:)?(?:hdop|accuracy)>([^<]+)<\/(?:\w+:)?(?:hdop|accuracy)>/.exec(body)?.[1];

    fixes.push({
      t,
      lat,
      lng,
      spd: spdRaw != null && Number.isFinite(Number(spdRaw)) ? Number(spdRaw) : null,
      // HDOP is not metres. Treated as a rough quality figure only; the real
      // accuracy filter downstream is the impossible-jump check.
      acc: accRaw != null && Number.isFinite(Number(accRaw)) ? Number(accRaw) * 5 : null,
      alt: null,
      heading: null,
    });
  }
  return fixes;
}

const text = readFileSync(resolve(file), 'utf8');
const isGpx = /\.gpx$/i.test(file) || /<gpx[\s>]/i.test(text.slice(0, 4000));

let raw;
if (isGpx) {
  const fixes = parseGpx(text);
  if (!fixes.length) {
    console.error('! no usable <trkpt> points with timestamps found in that GPX');
    process.exit(1);
  }
  const name = /<name>([^<]+)<\/name>/.exec(text)?.[1]?.trim();
  raw = {
    format: 'campusbus-trace/1',
    session: { id: `gpx-${fixes[0].t}`, name: name || 'Recorded ride', startedAt: fixes[0].t },
    // GPX has no notion of a tagged stop, so every stop name comes from
    // OpenStreetMap or from the halts the bus actually made.
    markers: [],
    fixes,
  };
  console.log(`\n▸ ${raw.session.name}  (GPX)`);
} else {
  raw = JSON.parse(text);
  if (raw.format !== 'campusbus-trace/1') {
    console.error(`! unexpected file format: ${raw.format ?? 'unknown'}`);
    process.exit(1);
  }
  console.log(`\n▸ ${raw.session?.name ?? file}`);
}

const NAME = flag('name', raw.session?.name || 'Recorded route');
console.log(`  ${raw.fixes.length} fixes, ${raw.markers.length} marked stops`);

// --- 1. clean -------------------------------------------------------------
let fixes = raw.fixes
  .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng))
  .filter((f) => f.acc == null || f.acc <= 50)
  .sort((a, b) => a.t - b.t);

const cleaned = [];
for (const f of fixes) {
  const prev = cleaned[cleaned.length - 1];
  if (!prev) { cleaned.push(f); continue; }
  const dt = (f.t - prev.t) / 1000;
  if (dt <= 0) continue;                              // duplicate / out of order
  const step = haversine(prev, f);
  if (step / dt > 35) continue;                       // 126 km/h — a GPS glitch
  // Deliberately KEEP stationary fixes. They look redundant, but a run of them
  // is precisely how a stop is detected — discarding them erases every halt.
  cleaned.push(f);
}
fixes = cleaned;
console.log(`  ${fixes.length} usable after filtering`);

if (fixes.length < 30) {
  console.error('! too few usable fixes to build a route.');
  process.exit(1);
}

const t0 = fixes[0].t;

// --- 2. shape -------------------------------------------------------------
// Smooth before simplifying. Raw GPS wander adds real length to the line — an
// unsmoothed trace measures several percent longer than the road actually is,
// which would bias every distance and therefore every ETA.
function smoothed(pts, win = 5) {
  const half = Math.floor(win / 2);
  return pts.map((_, i) => {
    let lng = 0, lat = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(pts.length - 1, i + half); k++) {
      lng += pts[k][0]; lat += pts[k][1]; n++;
    }
    return [lng / n, lat / n];
  });
}

let shape = simplify(smoothed(fixes.map((f) => [f.lng, f.lat])), 8);
console.log(`  simplified to ${shape.length} vertices`);

if (has('snap')) {
  try {
    process.stdout.write('  map-matching to roads … ');
    const down = simplify(shape, 20);
    shape = await mapMatch(down);
    console.log(`ok (${shape.length} vertices)`);
  } catch (e) {
    console.log(`failed (${e.message}) — keeping the raw trace`);
  }
}

const cum = cumulative(shape);
const total = cum[cum.length - 1];

// --- 3. halts = stops -----------------------------------------------------
// Any run where the bus barely moved for MIN_HALT_S is a stop, whether or not
// anyone remembered to tag it.
//
// Speed cannot be taken from consecutive fixes: a phone sitting still still
// wanders 5-10 m between readings, which differencing reads as ~8 m/s. So use
// the chip's own Doppler speed when it reports one, and otherwise measure
// displacement across a +/-5 second window, where the noise cancels out.
const WINDOW_MS = 5000;
function speedAt(i) {
  if (fixes[i].spd != null) return fixes[i].spd;
  let j = i, k = i;
  while (j > 0 && fixes[i].t - fixes[j].t < WINDOW_MS) j--;
  while (k < fixes.length - 1 && fixes[k].t - fixes[i].t < WINDOW_MS) k++;
  const dt = (fixes[k].t - fixes[j].t) / 1000;
  return dt > 0 ? haversine(fixes[j], fixes[k]) / dt : 0;
}

const halts = [];
let runStart = null;
for (let i = 1; i < fixes.length; i++) {
  const slow = speedAt(i) < 1.2;
  if (slow && runStart == null) runStart = i - 1;
  if (!slow && runStart != null) {
    const dur = (fixes[i - 1].t - fixes[runStart].t) / 1000;
    if (dur >= MIN_HALT_S) {
      const mid = fixes[Math.floor((runStart + i - 1) / 2)];
      halts.push({ lat: mid.lat, lng: mid.lng, t: mid.t, dur });
    }
    runStart = null;
  }
}
console.log(`  ${halts.length} halts of ${MIN_HALT_S}s or more`);

// Manual marks win; auto halts fill in what you did not tag.
const candidates = [
  { lat: fixes[0].lat, lng: fixes[0].lng, label: 'Start', manual: true },
  ...raw.markers.map((m) => ({ lat: m.lat, lng: m.lng, label: m.label || '', manual: true })),
  ...halts.map((h) => ({ lat: h.lat, lng: h.lng, label: '', manual: false })),
  { lat: fixes[fixes.length - 1].lat, lng: fixes[fixes.length - 1].lng, label: 'College Campus', manual: true },
];

const placed = candidates
  .map((c) => ({ ...c, distAlongM: Math.round(projectOnto(shape, cum, c).distAlong) }))
  .sort((a, b) => a.distAlongM - b.distAlongM);

// Collapse anything within 200 m into one stop, preferring the manual label.
const merged = [];
for (const c of placed) {
  const prev = merged[merged.length - 1];
  if (prev && c.distAlongM - prev.distAlongM < 200) {
    if (c.manual && !prev.manual) { prev.label = c.label; prev.manual = true; }
    continue;
  }
  merged.push({ ...c });
}

const taken = new Set(merged.filter((m) => m.label).map((m) => m.label));
const stops = [];
for (const m of merged) {
  let name = m.label;
  if (!name) {
    const p = atDistance(shape, cum, m.distAlongM);
    name = await placeName(p.lat, p.lng, taken);
  }
  if (!name) name = `Stop ${stops.length}`;
  taken.add(name);
  const p = atDistance(shape, cum, m.distAlongM);
  stops.push({
    id: `${ROUTE_ID}-s${stops.length}`,
    seq: stops.length,
    name,
    lat: +p.lat.toFixed(6),
    lng: +p.lng.toFixed(6),
    distAlongM: m.distAlongM,
    geofenceM: 80,
  });
}
console.log(`  ${stops.length} stops`);

// The college's own names beat anything reverse-geocoding can infer: the college
// knows a stop is called "Nindra X Road"; OpenStreetMap only knows which hamlet
// it sits in. So positions come from the ride, names come from the college.
if (NAMES_FROM) {
  const refPath = join(DATA, 'routes', `${NAMES_FROM}.json`);
  if (!existsSync(refPath)) {
    console.log(`  ! --names-from: no route named ${NAMES_FROM}`);
  } else {
    const ref = JSON.parse(readFileSync(refPath, 'utf8')).stops.map((s) => s.name);
    if (ref.length !== stops.length) {
      console.log(
        `  ! ${ref.length} known stops but ${stops.length} halts detected — names ` +
        'applied in order; check the ends, and adjust --min-halt if they are off',
      );
    }
    stops.forEach((s, i) => { if (ref[i]) s.name = ref[i]; });
    console.log(`  named from ${NAMES_FROM}`);
  }
}

// --- 4. profile + replayable trip ----------------------------------------
// Walk the fixes in time order with a forward-biased window. Searching the
// whole line for each fix would let a recording of an out-and-back route match
// the wrong leg, scrambling the time profile — the same trap the live engine
// guards against.
const walked = [];
let cursor = null;
for (const f of fixes) {
  const pr = cursor == null
    ? projectOnto(shape, cum, f)
    : projectOnto(shape, cum, f, cursor - 80, cursor + 500);
  cursor = Math.max(cursor ?? 0, pr.distAlong);
  walked.push(cursor);
}

const profile = [];
let pi = 0;
for (let d = 0; d <= total; d += 100) {
  while (pi < walked.length - 1 && walked[pi] < d) pi++;
  profile.push({ d: Math.round(d), t: Math.round((fixes[pi].t - t0) / 1000) });
}
const durationS = Math.round((fixes[fixes.length - 1].t - t0) / 1000);
if (profile[profile.length - 1].d < Math.round(total))
  profile.push({ d: Math.round(total), t: durationS });

const tAt = (d) => {
  for (let i = 1; i < profile.length; i++)
    if (profile[i].d >= d) {
      const span = profile[i].d - profile[i - 1].d || 1;
      return profile[i - 1].t + ((d - profile[i - 1].d) / span) * (profile[i].t - profile[i - 1].t);
    }
  return durationS;
};
stops.forEach((s) => (s.schedOffsetS = Math.round(tAt(s.distAlongM) / 30) * 30));

// Resample to a steady 1 Hz so replay behaves like a live device.
const points = [];
for (let sec = 0; sec <= durationS; sec++) {
  const target = t0 + sec * 1000;
  while (pi > 0 && fixes[pi].t > target) pi--;
  while (pi < fixes.length - 1 && fixes[pi + 1].t <= target) pi++;
  const a = fixes[pi], b = fixes[Math.min(pi + 1, fixes.length - 1)];
  const span = b.t - a.t || 1;
  const f = Math.max(0, Math.min(1, (target - a.t) / span));
  const dt = span / 1000;
  const v = dt > 0 ? haversine(a, b) / dt : 0;
  points.push({
    t: sec,
    lat: +(a.lat + f * (b.lat - a.lat)).toFixed(6),
    lng: +(a.lng + f * (b.lng - a.lng)).toFixed(6),
    spd: +Math.min(v, 30).toFixed(2),
    acc: a.acc ?? 10,
  });
}

// --- 5. write -------------------------------------------------------------
const schedStart = new Date(t0).toTimeString().slice(0, 5);
const route = {
  id: ROUTE_ID,
  code: String(CODE),
  name: NAME,
  short: NAME.split('—')[0].trim() || NAME,
  color: COLOR,
  schedStart,
  lengthM: Math.round(total),
  durationS,
  shape: shape.map(([lng, lat]) => [+lng.toFixed(6), +lat.toFixed(6)]),
  stops,
  profile,
  source: has('snap') ? 'recorded+osrm' : 'recorded',
  generatedAt: new Date().toISOString(),
};

mkdirSync(join(DATA, 'routes'), { recursive: true });
writeFileSync(join(DATA, 'routes', `${ROUTE_ID}.json`), JSON.stringify(route));
writeFileSync(
  join(DATA, 'routes', `${ROUTE_ID}.trip.json`),
  JSON.stringify({ routeId: ROUTE_ID, durationS, points }),
);

const netPath = join(DATA, 'network.json');
const net = JSON.parse(readFileSync(netPath, 'utf8'));
const summary = {
  id: ROUTE_ID, code: route.code, name: route.name, short: route.short,
  color: route.color, schedStart, lengthM: route.lengthM, durationS,
  stopCount: stops.length, firstStop: stops[0].name, lastStop: stops[stops.length - 1].name,
};
const at = net.routes.findIndex((r) => r.id === ROUTE_ID);
if (at === -1) net.routes.push(summary); else net.routes[at] = summary;
writeFileSync(netPath, JSON.stringify(net, null, 2));

console.log(`\n✓ ${(total / 1000).toFixed(1)} km · ${Math.round(durationS / 60)} min · ${stops.length} stops`);
console.log(`  ${stops.map((s) => s.name).join(' → ')}`);
console.log(`\n  written to data/routes/${ROUTE_ID}.json`);
console.log('  restart the server to pick it up\n');
