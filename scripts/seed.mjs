/**
 * Builds the real bus network around SVPCET, Puttur.
 *
 *   1. OSRM snaps each route corridor to actual roads.
 *   2. Nominatim reverse-geocodes stop positions so every stop is a real
 *      locality name, not a made-up one.
 *   3. A 1 Hz reference trip is simulated per route (acceleration limits,
 *      dwell at stops, signal halts, GPS noise) -> powers replay + the ETA model.
 *
 * Writes data/network.json and data/routes/<id>.json.
 * Geocoding is cached in data/geocache.json, so re-runs are instant and offline.
 *
 *   node scripts/seed.mjs              full build
 *   node scripts/seed.mjs --offline    straight lines, cached names only
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OFFLINE = process.argv.includes('--offline');
// Re-routing on every run means the road can shift slightly between builds —
// different OSRM instance, newer OSM data — so distances, stop positions and
// the timetable all move. Once a corridor is right it is FROZEN to disk and
// reused verbatim. Pass --refresh-shape to deliberately re-route.
const REFRESH_SHAPE = process.argv.includes('--refresh-shape');
const UA = { 'User-Agent': 'CampusBusTracker/0.1 (student project; local use)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ campus

const CAMPUS = {
  name: 'SVPCET',
  fullName: 'Sri Venkatesa Perumal College of Engineering & Technology',
  address: 'RVS Nagar, K N Road, Puttur, Tirupati Dist., Andhra Pradesh 517583',
  // The campus itself, not the junction outside it: OpenStreetMap way
  // 1253844941, amenity=college. The bus drives in off Chittoor - Puttur Road
  // and finishes inside the grounds, so that is where the route must end.
  lat: 13.43312,
  lng: 79.50944,
  catchmentKm: 50,
};

/**
 * The college runs ONE route: Nagalapuram to the campus.
 *
 * `via` are ANCHORS that shape the corridor — deliberately few, because routing
 * through every stop makes OSRM double back and inflates the line. Stops are
 * placed along the resulting road geometry afterwards.
 *
 * Pichatur is included as an anchor: it costs 4 km over the direct road, which
 * is a normal village-pickup detour. If the bus does not actually go that way,
 * delete that line and re-run.
 *
 *   ▸ WHEN YOU HAVE THE REAL STOP LIST, put it in `stops` below.
 *     Each entry needs a name, and optionally where it sits:
 *       { name: 'Pichatur' }                    placed evenly along the corridor
 *       { name: 'Pichatur', atM: 10900 }        exact metres along the route
 *       { name: 'Pichatur', lat: .., lng: .. }  projected onto the road
 *     Leave `stops` empty and the seeder invents plausible ones from
 *     OpenStreetMap, which is what it is doing now.
 */
const ROUTES = [
  {
    id: 'route-1',
    code: '1',
    name: 'Nagalapuram — Campus',
    short: 'Nagalapuram Line',
    color: '#f97316',
    schedStart: '07:05',
    // Keep this list SHORT. OSRM drives THROUGH every waypoint, so promoting a
    // village to an anchor makes the bus leave the highway, loop into the
    // village centre and come back — which is not what the bus does. Villages
    // that merely sit beside the road belong in the stops list, where they are
    // projected onto the line instead of routed through.
    //
    // Nindra is the one real exception: the college's list names Nindra X Road
    // on both sides of it, so the bus genuinely detours in and back out.
    via: [
      { name: 'Nagalapuram',   lat: 13.38618, lng: 79.79687 },
      { name: 'Pichatur',      lat: 13.40046, lng: 79.74125 },
      { name: 'Nindra',        lat: 13.38163, lng: 79.70780 },
      // Kappedu/Koppedu sits on a road parallel to the NH-716A bypass. The bus
      // serves the village, so it takes that road rather than the highway.
      { name: 'Koppedu',       lat: 13.40945, lng: 79.70398 },
      { name: 'Narayanavanam', lat: 13.42515, lng: 79.58754 },
      { name: 'Campus',        lat: CAMPUS.lat, lng: CAMPUS.lng },
    ],
    // The college's own list, in their order — treated as fact. Coordinates are
    // OpenStreetMap village nodes where one could be confirmed; the rest are
    // spaced between confirmed neighbours and marked with a tilde in the UI.
    //
    // Kailasakona is deliberately left without coordinates: OSM puts it at
    // 79.566, west of Vettalataduku, which would send the bus 20 km backwards
    // and return. The order the college gave is far better evidence than a
    // single node, so it is interpolated instead.
    stops: [
      { name: 'Nagalapuram Bus Stand', lat: 13.38618, lng: 79.79687 },
      { name: 'Krishnapuram',      lat: 13.39460, lng: 79.77601 },
      { name: 'Ramagiri',          lat: 13.39727, lng: 79.76614 },
      { name: 'Appambattu' },
      { name: 'Pichatur',          lat: 13.40046, lng: 79.74125 },
      { name: 'Nindra X Road' },
      { name: 'Nindra',            lat: 13.38163, lng: 79.70780 },
      { name: 'Nindra X Road (return)' },
      { name: 'Koppedu',           lat: 13.40945, lng: 79.70398 },
      { name: 'Palamangalam',      lat: 13.42205, lng: 79.67981 },
      { name: 'Chittoor Kandriga', lat: 13.40702, lng: 79.65064 },
      { name: 'Kailasakona' },
      { name: 'Vettalataduku',     lat: 13.41230, lng: 79.61009 },
      { name: 'Narayanavanam',     lat: 13.42515, lng: 79.58754 },
      { name: 'Puttur',            lat: 13.43814, lng: 79.55221 },
      { name: 'SVPCET' },
    ],
  },
];

// --------------------------------------------------------------------- geo

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
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
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
  let best = { d2: Infinity, distAlong: lo ?? 0, lng: p.lng, lat: p.lat };
  const from = lo == null ? 1 : Math.max(1, lb(cum, lo));
  const to = hi == null ? shape.length - 1 : Math.min(shape.length - 1, lb(cum, hi) + 1);
  const kLat = 111320;
  const kLng = 111320 * Math.cos(rad(p.lat));
  for (let i = from; i <= to; i++) {
    const [ax, ay] = shape[i - 1];
    const [bx, by] = shape[i];
    const axm = (ax - p.lng) * kLng, aym = (ay - p.lat) * kLat;
    const bxm = (bx - p.lng) * kLng, bym = (by - p.lat) * kLat;
    const dx = bxm - axm, dy = bym - aym;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(axm * dx + aym * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = axm + t * dx, cy = aym + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best.d2)
      best = {
        d2,
        distAlong: cum[i - 1] + t * (cum[i] - cum[i - 1]),
        lng: ax + t * (bx - ax),
        lat: ay + t * (by - ay),
      };
  }
  return best;
}

// ------------------------------------------------------- remote services

async function snapCorridor(via) {
  const coords = via.map((s) => `${s.lng},${s.lat}`).join(';');
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coords}` +
    `?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = await res.json();
  if (json.code !== 'Ok') throw new Error(`OSRM ${json.code}`);
  return json.routes[0].geometry.coordinates;
}

const cachePath = join(DATA, 'geocache.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

/** Returns the raw OSM address object so naming can fall back intelligently. */
async function addressAt(lat, lng) {
  const key = `a:${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (cache[key]) return cache[key];
  if (OFFLINE) return null;
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17` +
    `&lat=${lat}&lon=${lng}`;
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    cache[key] = j.address ?? {};
    writeFileSync(cachePath, JSON.stringify(cache, null, 0));
    await sleep(1100); // Nominatim fair-use policy
    return cache[key];
  } catch {
    return null;
  }
}

/**
 * Villages repeat for kilometres, so a naive reverse-geocode gives
 * "Tirupati, Tirupati 2, Tirupati 3". Walk a fallback chain instead and take
 * the first candidate nobody has claimed yet — usually a locality inside the
 * town, which is what a bus stop is actually called.
 */
/** "MDR0366", "Chennai - Tirupati Highway" — a road is not a place name. */
function isRoadish(s) {
  return (
    /^(NH|SH|MDR|ODR)[\s-]?\d+/i.test(s) ||
    /\b(road|highway|byp?ass|marg|street)\b/i.test(s) ||
    s.includes(' - ') ||
    s.length > 22
  );
}

function pickName(addr, taken) {
  if (!addr) return null;
  const chain = [
    addr.neighbourhood, addr.suburb, addr.hamlet, addr.village,
    addr.town, addr.city_district, addr.city,
  ].filter(Boolean).filter((c) => !isRoadish(c));
  for (const c of chain) if (!taken.has(c)) return c;
  // Village names run for kilometres. A second stop inside the same village is
  // real, so number it rather than dropping the stop entirely.
  if (chain.length) {
    for (let k = 2; k < 9; k++) if (!taken.has(`${chain[0]} ${k}`)) return `${chain[0]} ${k}`;
  }
  return null;
}

// ---------------------------------------------------------- trip simulation

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateTrip(shape, cum, stops, seed) {
  const rnd = mulberry32(seed);
  const total = cum[cum.length - 1];
  const A_ACC = 1.0, A_BRK = 1.6;

  const halts = [];
  for (let i = 0; i < Math.round(total / 6000); i++) {
    const d = total * (0.1 + 0.78 * rnd());
    if (stops.every((s) => Math.abs(s.distAlongM - d) > 500))
      halts.push({ d, wait: 18 + Math.round(50 * rnd()) });
  }

  const targets = [
    ...stops.slice(1).map((s) => ({ d: s.distAlongM, wait: 20 + Math.round(28 * rnd()) })),
    ...halts,
  ].sort((a, b) => a.d - b.d);

  // Village roads are slow; the highway stretches in the middle are quicker.
  const cruiseAt = (d) => {
    const f = d / total;
    const base = f < 0.12 ? 7.5 : f > 0.88 ? 7.0 : f < 0.35 || f > 0.7 ? 12.5 : 17.0;
    return base * (0.82 + 0.36 * rnd());
  };

  const points = [];
  let s = 0, v = 0, t = 0, ti = 0;
  let target = targets[0];
  let cruise = cruiseAt(0);

  const push = () => {
    const p = atDistance(shape, cum, s);
    const sigma = 4 + 4 * rnd();
    points.push({
      t,
      lat: +(p.lat + ((rnd() - 0.5) * sigma * 2) / 111320).toFixed(6),
      lng: +(p.lng + ((rnd() - 0.5) * sigma * 2) / (111320 * Math.cos(rad(p.lat)))).toFixed(6),
      spd: +v.toFixed(2),
      acc: +(5 + sigma).toFixed(1),
    });
  };

  push();
  const MAX_S = 4 * 3600;
  while (s < total - 2 && t < MAX_S) {
    const gap = target ? target.d - s : Infinity;
    const vTarget = gap <= (v * v) / (2 * A_BRK) + 6 ? 0 : cruise;
    v = Math.max(0, v + Math.max(-A_BRK, Math.min(A_ACC, vTarget - v)));
    s += v;
    t += 1;
    push();

    if (target && (s >= target.d - 8 || (v <= 0.35 && gap <= 25))) {
      s = target.d; v = 0;
      for (let w = 0; w < target.wait; w++) { t += 1; push(); }
      target = targets[++ti];
      cruise = cruiseAt(s);
    } else if (v <= 0.05) {
      v = 0.5; // never stall between targets
    }
    if (v > 0.2 && rnd() < 0.006) cruise = cruiseAt(s);
  }
  return points;
}

function buildProfile(points, shape, cum, step = 100) {
  const total = cum[cum.length - 1];
  // Forward-biased window: this route doubles back through Pichatur, and a
  // full-line search would match the wrong leg and scramble the time profile.
  const walked = [];
  let cursor = null;
  for (const p of points) {
    const pr = cursor == null
      ? projectOnto(shape, cum, p)
      : projectOnto(shape, cum, p, cursor - 80, cursor + 500);
    cursor = Math.max(cursor ?? 0, pr.distAlong);
    walked.push(cursor);
  }
  const samples = [];
  let pi = 0;
  for (let d = 0; d <= total; d += step) {
    while (pi < walked.length - 1 && walked[pi] < d) pi++;
    samples.push({ d: Math.round(d), t: points[pi].t });
  }
  const last = points[points.length - 1];
  if (samples[samples.length - 1].d < Math.round(total))
    samples.push({ d: Math.round(total), t: last.t });
  return samples;
}

// -------------------------------------------------------------------- main

mkdirSync(join(DATA, 'routes'), { recursive: true });
mkdirSync(join(DATA, 'trips'), { recursive: true });

const index = [];
let seedN = 11;

/** Simulate the reference trip, derive the profile and schedule, and write it. */
function finish(def, shape, cum, total, stops) {
  process.stdout.write('  reference trip … ');
  const points = simulateTrip(shape, cum, stops, seedN++);
  const profile = buildProfile(points, shape, cum);
  console.log(`${(points[points.length - 1].t / 60).toFixed(0)} min`);

  const tAt = (d) => {
    for (let i = 1; i < profile.length; i++)
      if (profile[i].d >= d) {
        const span = profile[i].d - profile[i - 1].d || 1;
        const f = (d - profile[i - 1].d) / span;
        return profile[i - 1].t + f * (profile[i].t - profile[i - 1].t);
      }
    return profile[profile.length - 1].t;
  };
  stops.forEach((s) => (s.schedOffsetS = Math.round(tAt(s.distAlongM) / 30) * 30));

  const route = {
    id: def.id,
    code: def.code,
    name: def.name,
    short: def.short,
    color: def.color,
    schedStart: def.schedStart,
    lengthM: Math.round(total),
    durationS: points[points.length - 1].t,
    shape: shape.map(([lng, lat]) => [+lng.toFixed(6), +lat.toFixed(6)]),
    stops,
    profile,
    source: OFFLINE ? 'straight-line' : 'osrm',
    // No build timestamp here on purpose: it would make the output differ on
    // every run, which is precisely what we are trying to rule out. The date
    // the corridor was frozen lives in <id>.shape.json, where it is meaningful.
  };

  writeFileSync(join(DATA, 'routes', `${def.id}.json`), JSON.stringify(route));
  writeFileSync(
    join(DATA, 'routes', `${def.id}.trip.json`),
    JSON.stringify({ routeId: def.id, durationS: route.durationS, points }),
  );

  console.log(`  ${(total / 1000).toFixed(1)} km · ${stops.length} stops`);
  for (const s of stops) {
    // Distance from the village centre to the road. Large is not wrong: the
    // bus stop is where the highway meets the village, not its centre. Only a
    // huge figure means the corridor is on the wrong road entirely.
    const off = s._offBy == null ? '' : s._offBy > 2500 ? `   ⚠ ${s._offBy} m — check the corridor` : `   ${s._offBy} m to village centre`;
    console.log(`    ${String(s.seq).padStart(2)}  ${(s.distAlongM / 1000).toFixed(1).padStart(5)} km  ${s.name.padEnd(26)}${s.estimated ? '~' : ' '}${off}`);
  }

  stops.forEach((s) => delete s._offBy);

  index.push({
    id: def.id, code: def.code, name: def.name, short: def.short,
    color: def.color, schedStart: def.schedStart,
    lengthM: route.lengthM, durationS: route.durationS, stopCount: stops.length,
    firstStop: stops[0].name, lastStop: stops[stops.length - 1].name,
  });
}

for (const def of ROUTES) {
  process.stdout.write(`\n▸ ${def.name}\n  corridor … `);

  const shapePath = join(DATA, 'routes', `${def.id}.shape.json`);
  let shape;

  if (!REFRESH_SHAPE && existsSync(shapePath)) {
    // The frozen corridor is the source of truth. Reusing it byte for byte is
    // what guarantees the bus follows the same road, with the same distances
    // and the same timetable, on every single build.
    const saved = JSON.parse(readFileSync(shapePath, 'utf8'));
    shape = saved.shape;
    console.log(`frozen · ${shape.length} vertices · ${saved.frozenAt.slice(0, 10)}`);
  } else if (OFFLINE) {
    shape = def.via.map((v) => [v.lng, v.lat]);
    console.log('offline (straight lines)');
  } else {
    try {
      shape = await snapCorridor(def.via);
      console.log(`${shape.length} vertices from OSRM`);
    } catch (e) {
      shape = def.via.map((v) => [v.lng, v.lat]);
      console.log(`OSRM failed (${e.message}) — straight lines`);
    }
    writeFileSync(shapePath, JSON.stringify({
      routeId: def.id,
      frozenAt: new Date().toISOString(),
      via: def.via,
      shape: shape.map(([lng, lat]) => [+lng.toFixed(6), +lat.toFixed(6)]),
    }));
    console.log('  · corridor frozen — every later run reuses it exactly');
  }

  const cum = cumulative(shape);
  const total = cum[cum.length - 1];

  // A real stop list always wins over anything the seeder can infer.
  if (def.stops?.length) {
    const n = def.stops.length;

    // Pass 1 — place every stop we actually know the position of.
    const at = def.stops.map((s) =>
      s.atM != null ? s.atM
      : s.lat != null && s.lng != null ? Math.round(projectOnto(shape, cum, s).distAlong)
      : null,
    );
    if (at[0] == null) at[0] = 0;
    if (at[n - 1] == null) at[n - 1] = Math.round(total);

    // Pass 2 — anything unknown is spread evenly between the known stops on
    // either side of it. The ORDER is what the college told us and is treated
    // as fact; only the spacing is a guess, and one recorded ride replaces it.
    let known = 0;
    for (let i = 1; i < n; i++) {
      if (at[i] == null) continue;
      const gap = i - known;
      for (let k = 1; k < gap; k++) {
        at[known + k] = Math.round(at[known] + ((at[i] - at[known]) * k) / gap);
      }
      known = i;
    }

    // The two terminals are pinned to the ends of the corridor, so they are
    // known even when the list gave no coordinates for them.
    const estimated = def.stops.map(
      (s, i) => i !== 0 && i !== n - 1 && s.atM == null && s.lat == null,
    );

    // A pinned village sitting far from the line means the corridor does not
    // actually pass it — the signal that it needs to become an anchor.
    const offBy = def.stops.map((s, i) =>
      s.lat != null ? Math.round(haversine(s, atDistance(shape, cum, at[i]))) : null,
    );
    const stops = def.stops.map((s, i) => {
      const p = atDistance(shape, cum, at[i]);
      return {
        id: `${def.id}-s${i}`,
        seq: i,
        name: s.name,
        lat: +p.lat.toFixed(6),
        lng: +p.lng.toFixed(6),
        distAlongM: at[i],
        geofenceM: s.geofenceM ?? 80,
        estimated: estimated[i],
        _offBy: offBy[i],
      };
    });

    finish(def, shape, cum, total, stops);
    continue;
  }

  // Anchors are places we already know the name of, so they are ALWAYS stops.
  // Pichatur must appear on route 1 whether or not OSM reverse-geocodes it.
  const anchors = def.via
    .map((v) => {
      const pr = projectOnto(shape, cum, v);
      return {
        d: Math.round(pr.distAlong),
        name: v.name === 'Campus' ? 'College Campus' : v.name,
        lat: pr.lat, lng: pr.lng, anchor: true,
      };
    })
    .sort((a, b) => a.d - b.d);
  anchors[0].d = 0;
  anchors[anchors.length - 1].d = Math.round(total);

  // Fill each gap between anchors with roughly one stop every 3 km.
  const SPACING = 2500;
  const slots = [];
  for (let i = 0; i < anchors.length; i++) {
    slots.push(anchors[i]);
    const next = anchors[i + 1];
    if (!next) break;
    const gap = next.d - anchors[i].d;
    const k = Math.floor(gap / SPACING);
    for (let j = 1; j <= k; j++) {
      const d = anchors[i].d + (gap * j) / (k + 1);
      const p = atDistance(shape, cum, d);
      slots.push({ d: Math.round(d), name: null, lat: p.lat, lng: p.lng, anchor: false });
    }
  }
  slots.sort((a, b) => a.d - b.d);

  const seen = new Set(anchors.map((a) => a.name));
  const stops = [];
  for (const slot of slots) {
    const name = slot.anchor ? slot.name : pickName(await addressAt(slot.lat, slot.lng), seen);
    if (!name) continue; // no real locality here — better no stop than a fake one
    seen.add(name);
    stops.push({
      id: `${def.id}-s${stops.length}`,
      seq: stops.length,
      name,
      lat: +slot.lat.toFixed(6),
      lng: +slot.lng.toFixed(6),
      distAlongM: slot.d,
      geofenceM: 80,
    });
  }

  finish(def, shape, cum, total, stops);
}

writeFileSync(
  join(DATA, 'network.json'),
  JSON.stringify({ campus: CAMPUS, routes: index, generatedAt: new Date().toISOString() }, null, 2)
);

console.log(`\n✓ ${index.length} routes written to data/routes/`);
console.log(`✓ network.json — campus + ${CAMPUS.catchmentKm} km catchment\n`);
