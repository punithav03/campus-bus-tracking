#!/usr/bin/env node
/**
 * Builds route-2 (Kaluru) and route-3 (Tirupati Town) into the same shape the
 * engine already reads for route-1, and refreshes data/network.json.
 *
 * Route 1 is NOT touched. It was validated against a real recorded ride and is
 * the reference the other two will eventually be held to.
 *
 * ── On the stop positions ──────────────────────────────────────────────────
 * Each stop below is marked `osm` (found in OpenStreetMap), `ride` (taken from
 * route-1's validated data) or `approx`.
 *
 * An `approx` stop has no position of its own. It is placed ON the real road
 * line, evenly spaced between its nearest confirmed neighbours, which keeps the
 * ordering and the distances honest even though the pin is a guess. Those stops
 * are flagged `estimated: true` so the UI can show them as approximate, and
 * they carry a wider geofence so a bus still registers as having passed.
 *
 * To replace the guesses with measurements: ride the route with the recorder,
 * then run `npm run import-trace` — the same path route 1 took to 3 m accuracy.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join(process.cwd(), 'data');
const ROUTES = join(DATA, 'routes');
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

// ---------------------------------------------------------------------------
// Stop tables.  [name, scheduled HH:MM, lat, lng, source]
// A null lat/lng means "place it on the road between the neighbours".
// ---------------------------------------------------------------------------

const ROUTE_2 = {
  id: 'route-2',
  code: '2',
  name: 'Kaluru — Campus',
  short: 'Kaluru Line',
  color: '#f5b301',
  driver: { name: 'Eswar', phone: '8686288604' },
  stops: [
    ['Kaluru',           '07:20', 13.602890, 79.343600, 'osm'],
    ['Balaji Colony',    '07:45', 13.632009, 79.414347, 'osm'],
    ['MR Palli Circle',  '07:55', 13.615589, 79.410881, 'osm'],
    ['Annamayya Circle', '08:00', null,      null,      'approx'],
    ['DR Mahal',         '08:05', null,      null,      'approx'],
    ['Bliss Circle',     '08:10', 13.625410, 79.432364, 'approx'],
    ['Srinivasapuram',   '08:15', 13.617277, 79.433034, 'osm'],
    ['Mango Mart',       '08:20', null,      null,      'approx'],
    ['Tiruchanoor',      '08:25', 13.606075, 79.448736, 'osm'],
    ['Pudi Gate',        '08:50', 13.552817, 79.509638, 'osm'],
    ['Vadamalapeta',     '08:55', 13.548721, 79.525201, 'osm'],
    ['Puttur',           '09:10', 13.438085, 79.551878, 'ride'],
    ['SVPCET',           '09:20', 13.433591, 79.509652, 'ride'],
  ],
};

const ROUTE_3 = {
  id: 'route-3',
  code: '3',
  name: 'Tirupati Town — Campus',
  short: 'Tirupati Line',
  color: '#38bdf8',
  driver: { name: 'Shankar', phone: '9573061292' },
  stops: [
    ['Mahathi',              '07:50', 13.631288, 79.412367, 'osm'],
    ['Crime Police Station', '07:55', 13.633591, 79.413525, 'osm'],
    ['Medical College',      '08:00', 13.642574, 79.406428, 'osm'],
    ['ISKCON Temple',        '08:05', 13.646837, 79.413725, 'osm'],
    ['Anna Rao Circle',      '08:10', 13.647253, 79.419371, 'osm'],
    ['Kapilateertham',       '08:15', 13.656576, 79.421034, 'osm'],
    ['Leela Mahal',          '08:20', 13.641813, 79.427691, 'osm'],
    ['Korlagunta',           '08:25', 13.636963, 79.425289, 'osm'],
    ['Bliss Circle',         '08:30', 13.625410, 79.432364, 'approx'],
    ['Renigunta',            '08:45', 13.638451, 79.510519, 'osm'],
    ['Puttur Bypass',        '09:20', 13.431116, 79.557347, 'ride'],
    ['SVPCET',               '09:30', 13.433591, 79.509652, 'ride'],
  ],
};

// ---------------------------------------------------------------------------
// Geometry.  Shapes are stored [lng, lat] to match route-1 and GeoJSON.
// ---------------------------------------------------------------------------

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const p1 = rad(a[1]); const p2 = rad(b[1]);
  const dp = p2 - p1;
  const dl = rad(b[0] - a[0]);
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function cumulative(shape) {
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + haversine(shape[i - 1], shape[i]));
  return cum;
}

/** Nearest point on the line → { distAlongM, point, offsetM }. */
function project(shape, cum, pt) {
  let best = { distAlongM: 0, point: shape[0], offsetM: Infinity };
  for (let i = 0; i < shape.length - 1; i++) {
    const [ax, ay] = shape[i];
    const [bx, by] = shape[i + 1];
    const dx = bx - ax; const dy = by - ay;
    const seg2 = dx * dx + dy * dy;
    let t = seg2 === 0 ? 0 : ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / seg2;
    t = Math.max(0, Math.min(1, t));
    const p = [ax + t * dx, ay + t * dy];
    const off = haversine(pt, p);
    if (off < best.offsetM) {
      best = { distAlongM: cum[i] + haversine([ax, ay], p), point: p, offsetM: off };
    }
  }
  return best;
}

/** The point sitting `target` metres along the line. */
function pointAt(shape, cum, target) {
  if (target <= 0) return shape[0];
  if (target >= cum[cum.length - 1]) return shape[shape.length - 1];
  let lo = 0; let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span === 0 ? 0 : (target - cum[lo]) / span;
  return [shape[lo][0] + t * (shape[hi][0] - shape[lo][0]),
          shape[lo][1] + t * (shape[hi][1] - shape[lo][1])];
}

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

async function osrm(points) {
  const coords = points.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url = `${OSRM}${coords}?overview=full&geometries=geojson&continue_straight=true`;
  const res = await fetch(url, { headers: { 'user-agent': 'SVPCETBus/1.0' } });
  const j = await res.json();
  if (j.code !== 'Ok') throw new Error(`OSRM ${j.code}: ${j.message ?? ''}`);
  return j.routes[0].geometry.coordinates;   // already [lng, lat]
}

// ---------------------------------------------------------------------------

async function build(def) {
  const cachePath = join(ROUTES, `${def.id}.shape.json`);
  let shape;

  if (existsSync(cachePath) && !process.argv.includes('--refresh-shape')) {
    shape = JSON.parse(readFileSync(cachePath, 'utf8')).shape;
    console.log(`  shape: ${shape.length} points (cached)`);
  } else {
    const anchors = def.stops.filter((s) => s[2] != null).map((s) => [s[3], s[2]]);
    shape = await osrm(anchors);
    writeFileSync(cachePath, JSON.stringify({
      routeId: def.id,
      frozenAt: new Date().toISOString(),
      via: anchors,
      shape,
    }));
    console.log(`  shape: ${shape.length} points (from OSRM)`);
  }

  const cum = cumulative(shape);
  const lengthM = Math.round(cum[cum.length - 1]);

  // Pin the stops we know, then fill the gaps along the road.
  const pinned = new Map();
  def.stops.forEach((s, i) => {
    if (s[2] == null) return;
    pinned.set(i, project(shape, cum, [s[3], s[2]]));
  });

  const t0 = minutes(def.stops[0][1]);
  const stops = def.stops.map(([name, sched, , , source], i) => {
    let lng; let lat; let distAlongM; let estimated;

    if (pinned.has(i)) {
      const p = pinned.get(i);
      [lng, lat] = p.point;
      distAlongM = p.distAlongM;
      estimated = source === 'approx';
      if (p.offsetM > 400) {
        console.log(`  ! ${name} sits ${Math.round(p.offsetM)} m off the road line`);
      }
    } else {
      const before = Math.max(...[...pinned.keys()].filter((k) => k < i));
      const after = Math.min(...[...pinned.keys()].filter((k) => k > i));
      const gap = [];
      for (let j = before + 1; j < after; j++) gap.push(j);
      const step = (pinned.get(after).distAlongM - pinned.get(before).distAlongM) / (gap.length + 1);
      distAlongM = pinned.get(before).distAlongM + step * (gap.indexOf(i) + 1);
      [lng, lat] = pointAt(shape, cum, distAlongM);
      estimated = true;
    }

    return {
      id: `${def.id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      seq: i,
      name,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      distAlongM: Math.round(distAlongM),
      // A guessed pin needs a wider net, or a bus that passed it never registers.
      geofenceM: estimated ? 180 : 80,
      schedOffsetS: (minutes(sched) - t0) * 60,
      estimated,
    };
  });

  for (let i = 1; i < stops.length; i++) {
    if (stops[i].distAlongM <= stops[i - 1].distAlongM) {
      console.log(`  ! out of order: ${stops[i - 1].name} → ${stops[i].name}`);
    }
  }

  // ETA baseline, straight from the college timetable: a time-vs-distance curve
  // through the scheduled stops. Measured rides replace this later, exactly as
  // they did for route 1.
  const durationS = stops[stops.length - 1].schedOffsetS;
  const profile = [];
  const SAMPLES = 400;
  for (let k = 0; k <= SAMPLES; k++) {
    const d = (lengthM * k) / SAMPLES;
    let a = stops[0]; let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (d >= stops[i].distAlongM && d <= stops[i + 1].distAlongM) {
        a = stops[i]; b = stops[i + 1]; break;
      }
    }
    const span = b.distAlongM - a.distAlongM;
    const f = span === 0 ? 0 : (d - a.distAlongM) / span;
    profile.push({
      d: Math.round(d),
      t: Math.round(a.schedOffsetS + f * (b.schedOffsetS - a.schedOffsetS)),
    });
  }

  const route = {
    id: def.id,
    code: def.code,
    name: def.name,
    short: def.short,
    color: def.color,
    schedStart: def.stops[0][1],
    lengthM,
    durationS,
    shape,
    stops,
    profile,
    source: 'osrm',
    tripSource: 'timetable',
    driver: def.driver,
  };

  writeFileSync(join(ROUTES, `${def.id}.json`), JSON.stringify(route));
  console.log(`  ${stops.length} stops · ${(lengthM / 1000).toFixed(1)} km · ${Math.round(durationS / 60)} min`);
  for (const s of stops) {
    console.log(`    ${String(Math.floor(s.schedOffsetS / 60)).padStart(3)}m  ${(s.distAlongM / 1000).toFixed(2).padStart(6)} km  ${s.name}${s.estimated ? '  ~' : ''}`);
  }
  return route;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(ROUTES)) mkdirSync(ROUTES, { recursive: true });

  const built = [];
  for (const def of [ROUTE_2, ROUTE_3]) {
    console.log(`\n=== ${def.id}  ${def.name} ===`);
    built.push(await build(def));
  }

  // Refresh the network index, keeping route 1 exactly as it is.
  const netPath = join(DATA, 'network.json');
  const net = JSON.parse(readFileSync(netPath, 'utf8'));
  const summary = (r) => ({
    id: r.id, code: r.code, name: r.name, short: r.short, color: r.color,
    schedStart: r.schedStart, lengthM: r.lengthM, durationS: r.durationS,
    stopCount: r.stops.length,
    firstStop: r.stops[0].name,
    lastStop: r.stops[r.stops.length - 1].name,
  });

  const keep = net.routes.filter((r) => !built.some((b) => b.id === r.id));
  net.routes = [...keep, ...built.map(summary)].sort((a, b) => a.code.localeCompare(b.code));
  net.generatedAt = new Date().toISOString();
  writeFileSync(netPath, JSON.stringify(net, null, 1));

  console.log(`\nnetwork.json → ${net.routes.map((r) => r.id).join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
