/**
 * Turns a recorded ride into the route's reference trip.
 *
 *   node scripts/build-ride.mjs <route-id> <track.gpx>
 *
 * The seeder normally invents the reference trip by simulation, and that
 * simulation was 14 minutes optimistic over the recorded stretch — every ETA a
 * student saw was too early. A real ride is strictly better evidence, so once
 * one exists it becomes the reference and the schedule is derived from it.
 *
 * The recording covers Pichatur onward, not the whole line. Rather than throw
 * away the part it does cover, the head keeps its simulated shape but is
 * stretched by the pace error the real ride actually revealed — an assumption,
 * clearly, but a measured one, and far closer than pretending the simulation
 * was right. The moment someone records the full run this file is rebuilt from
 * it and the assumption disappears.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'routes');

const [routeId, gpxPath] = process.argv.slice(2);
if (!routeId || !gpxPath) {
  console.error('usage: node scripts/build-ride.mjs <route-id> <track.gpx>');
  process.exit(1);
}

const route = JSON.parse(readFileSync(join(DATA, `${routeId}.json`), 'utf8'));
const shape = route.shape.map(([lng, lat]) => ({ lat, lng }));

const R = 6371008.8, rad = d => d * Math.PI / 180;
const hav = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const cum = [0];
for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + hav(shape[i - 1], shape[i]));
const TOTAL = cum[cum.length - 1];

function project(p, from, to) {
  let best = { d: Infinity, at: from };
  for (let i = 1; i < shape.length; i++) {
    if (cum[i] < from || cum[i - 1] > to) continue;
    const a = shape[i - 1], b = shape[i];
    const kx = 111320 * Math.cos(rad((a.lat + b.lat) / 2)), ky = 110540;
    const ax = a.lng * kx, ay = a.lat * ky, bx = b.lng * kx, by = b.lat * ky;
    const px = p.lng * kx, py = p.lat * ky;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.d) best = { d, at: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
  }
  return best;
}

// ---- the recorded track ----------------------------------------------------
const gpx = readFileSync(gpxPath, 'utf8');
const track = [...gpx.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g)]
  .map(m => ({
    lat: +m[1], lng: +m[2],
    t: Date.parse((/<time>([^<]+)<\/time>/.exec(m[3]) || [])[1]),
    spd: +((/<speed>([-\d.]+)<\/speed>/.exec(m[3]) || [])[1] ?? 0),
  }))
  .filter(p => Number.isFinite(p.t))
  .sort((a, b) => a.t - b.t);

// Forward-only, in time order. A nearest-point search is ambiguous wherever the
// route doubles back, and this one does at Nindra.
let cursor = project(track[0], 0, TOTAL).at;
const joinsAt = cursor;
for (const p of track) {
  const r = project(p, Math.max(0, cursor - 60), cursor + 900);
  if (r.d < 200) { p.at = r.at; cursor = r.at; } else p.at = cursor;
}

// Drop the stationary lead-in: the rider boarded and waited, which says nothing
// about how long the bus takes and would inflate every downstream estimate.
let start = 0;
while (start < track.length - 1 && track[start].at - track[0].at < 15) start++;
const moving = track.slice(start);
const t0 = moving[0].t;
const realS = (moving[moving.length - 1].t - t0) / 1000;
const realFrom = moving[0].at, realTo = moving[moving.length - 1].at;

// ---- the simulated trip we are replacing -----------------------------------
const simPath = join(DATA, `${routeId}.trip.json`);
if (!existsSync(simPath)) { console.error('no simulated trip to take the head from — run npm run seed first'); process.exit(1); }
const sim = JSON.parse(readFileSync(simPath, 'utf8')).points;

let simCursor = 0;
for (const p of sim) {
  const r = project(p, Math.max(0, simCursor - 60), simCursor + 900);
  if (r.d < 200) { p.at = r.at; simCursor = r.at; } else p.at = simCursor;
}
const simHead = sim.filter(p => p.at < realFrom);
const simSame = sim.filter(p => p.at >= realFrom && p.at <= realTo);
const simS = simSame.length ? simSame[simSame.length - 1].t - simSame[0].t : realS;
const stretch = realS / simS;

console.log(`route          ${routeId}  (${(TOTAL / 1000).toFixed(1)} km)`);
console.log(`recording      joins at ${(joinsAt / 1000).toFixed(2)} km, ends at ${(realTo / 1000).toFixed(2)} km`);
console.log(`real           ${Math.round(realS / 60)} min over that stretch`);
console.log(`simulated      ${Math.round(simS / 60)} min over the same stretch`);
console.log(`pace error     simulation was ${(stretch).toFixed(2)}x too fast`);

// ---- splice ----------------------------------------------------------------
const headS = simHead.length ? (simHead[simHead.length - 1].t - simHead[0].t) * stretch : 0;
const points = [];
for (const p of simHead) {
  points.push({ t: Math.round((p.t - simHead[0].t) * stretch), lat: p.lat, lng: p.lng, spd: p.spd, acc: p.acc ?? 12 });
}
for (const p of moving) {
  points.push({
    t: Math.round(headS + (p.t - t0) / 1000),
    lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6),
    spd: Math.round(p.spd * 10) / 10, acc: 6,
  });
}
// strictly increasing time, or the engine will reject fixes as out of order
for (let i = 1; i < points.length; i++) if (points[i].t <= points[i - 1].t) points[i].t = points[i - 1].t + 1;

const out = {
  routeId,
  durationS: points[points.length - 1].t,
  source: 'recorded',
  recordedAt: new Date(moving[0].t).toISOString(),
  coversFromM: Math.round(realFrom),
  headIsSimulatedStretchedBy: +stretch.toFixed(3),
  points,
};
writeFileSync(join(DATA, `${routeId}.ride.json`), JSON.stringify(out));

console.log(`\nhead           ${simHead.length} simulated points, stretched  (0 -> ${(realFrom / 1000).toFixed(2)} km, ${Math.round(headS / 60)} min)`);
console.log(`recorded       ${moving.length} real points  (${Math.round(realS / 60)} min)`);
console.log(`total          ${points.length} points, ${Math.round(out.durationS / 60)} min end to end`);
console.log(`\nwritten to data/routes/${routeId}.ride.json — npm run seed will now use it`);
