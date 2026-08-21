/**
 * Replays a reference trip through a faithful copy of the engine's accept()
 * filters and reports WHY each fix was rejected.
 *
 *   node scripts/diagnose-ingest.mjs route-1
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? 'route-1';
const route = JSON.parse(readFileSync(join(ROOT, 'data', 'routes', `${id}.json`), 'utf8'));
const trip = JSON.parse(readFileSync(join(ROOT, 'data', 'routes', `${id}.trip.json`), 'utf8'));

const MAX_ACCURACY_M = 75, MAX_OFFSET_M = 250, MAX_BACKWARD_M = 150;
const MAX_SPEED_MPS = 30, PROJECT_WINDOW_M = 1200;
const ALPHA = 0.45, BETA = 0.09, ARRIVE_SPEED_MPS = 1.6;

const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
const hv = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const shape = route.shape;
const cum = [0];
for (let i = 1; i < shape.length; i++) {
  cum.push(cum[i - 1] + hv({ lng: shape[i - 1][0], lat: shape[i - 1][1] },
                            { lng: shape[i][0], lat: shape[i][1] }));
}
const lb = (d) => {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  return lo;
};
function projectOnto(p, near, W) {
  let from = 1, to = shape.length - 1;
  if (near != null) {
    from = Math.max(1, lb(near - W));
    to = Math.min(shape.length - 1, lb(near + W) + 1);
  }
  const kLat = 111320, kLng = 111320 * Math.cos(rad(p.lat));
  let best = { d2: Infinity, distAlong: near ?? 0, offsetM: 0 };
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
    if (d2 < best.d2)
      best = { d2, distAlong: cum[i - 1] + t * (cum[i] - cum[i - 1]), offsetM: Math.sqrt(d2) };
  }
  return best;
}

const t0 = Date.now();
const pings = trip.points.map((p) => ({ lat: p.lat, lng: p.lng, spd: p.spd, acc: p.acc, t: t0 + p.t * 1000 }));

const why = { accuracy: 0, speed: 0, outOfOrder: 0, offRoute: 0, backwards: 0 };
let dist = 0, v = 0, lastT = 0, kept = 0, first = true;
const events = new Set();
let maxOffset = 0;

for (const p of pings) {
  if (p.acc != null && p.acc > MAX_ACCURACY_M) { why.accuracy++; continue; }
  if (p.spd != null && p.spd > MAX_SPEED_MPS) { why.speed++; continue; }
  if (!first && p.t <= lastT) { why.outOfOrder++; continue; }

  const dtS = first ? 1 : Math.max(0.25, (p.t - lastT) / 1000);
  const proj = projectOnto(p, first ? null : dist, PROJECT_WINDOW_M);
  maxOffset = Math.max(maxOffset, proj.offsetM);
  if (proj.offsetM > MAX_OFFSET_M) { why.offRoute++; continue; }
  if (!first && proj.distAlong < dist - MAX_BACKWARD_M) { why.backwards++; continue; }

  if (first) { dist = proj.distAlong; v = p.spd ?? 0; first = false; }
  else {
    const predicted = dist + v * dtS;
    const residual = proj.distAlong - predicted;
    dist = predicted + ALPHA * residual;
    v = Math.max(0, Math.min(MAX_SPEED_MPS, v + (BETA / dtS) * residual));
  }
  lastT = p.t;
  kept++;

  for (const s of route.stops) {
    if (Math.abs(dist - s.distAlongM) <= s.geofenceM && v <= ARRIVE_SPEED_MPS) events.add(s.seq);
  }
}

const total = pings.length;
console.log(`\n${id} — ${total} fixes fed\n`);
console.log(`  kept      ${String(kept).padStart(5)}  (${((kept / total) * 100).toFixed(0)}%)`);
for (const [k, n] of Object.entries(why)) {
  if (n) console.log(`  ${k.padEnd(10)}${String(n).padStart(5)}  (${((n / total) * 100).toFixed(0)}%)`);
}
console.log(`\n  max distance off the route line: ${maxOffset.toFixed(0)} m  (limit ${MAX_OFFSET_M})`);
console.log(`  arrivals detected: ${events.size} of ${route.stops.length}`);
const missed = route.stops.filter((s) => !events.has(s.seq)).map((s) => s.name);
if (missed.length) console.log(`  missed: ${missed.join(', ')}`);
console.log('');
