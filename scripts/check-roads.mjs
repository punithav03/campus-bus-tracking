/**
 * Which roads does the frozen corridor actually drive on?
 *
 * A college bus route should spend its kilometres on named highways and district
 * roads. If most of the distance is on unnamed village lanes, the router has
 * been pulled off the main road — usually by an anchor sitting in a village
 * centre rather than on the highway.
 *
 *   node scripts/check-roads.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? 'route-1';
const shapePath = join(ROOT, 'data', 'routes', `${id}.shape.json`);

if (!existsSync(shapePath)) {
  console.error(`no frozen corridor at ${shapePath} — run npm run seed first`);
  process.exit(1);
}

const { via } = JSON.parse(readFileSync(shapePath, 'utf8'));
const coords = via.map((v) => `${v.lng},${v.lat}`).join(';');

const url =
  `https://router.project-osrm.org/route/v1/driving/${coords}` +
  `?overview=false&steps=true`;

const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
const json = await res.json();
if (json.code !== 'Ok') {
  console.error(`OSRM ${json.code}`);
  process.exit(1);
}

const byRoad = new Map();
for (const leg of json.routes[0].legs ?? []) {
  for (const st of leg.steps ?? []) {
    const nm = st.name?.trim() || '(unnamed lane)';
    byRoad.set(nm, (byRoad.get(nm) ?? 0) + st.distance);
  }
}

const total = json.routes[0].distance;
const roads = [...byRoad.entries()].sort((a, b) => b[1] - a[1]);

console.log(`\n${id} — ${(total / 1000).toFixed(1)} km via ${via.map((v) => v.name).join(' → ')}\n`);
for (const [nm, d] of roads.slice(0, 10)) {
  const pct = ((d / total) * 100).toFixed(0);
  console.log(`  ${(d / 1000).toFixed(1).padStart(6)} km  ${pct.padStart(3)}%  ${nm}`);
}

const unnamed = byRoad.get('(unnamed lane)') ?? 0;
const share = (unnamed / total) * 100;
console.log(
  `\n  unnamed lanes: ${(unnamed / 1000).toFixed(1)} km (${share.toFixed(0)}%) — ` +
  (share > 25 ? '⚠ too much, the corridor is off the main road' : 'fine for village pickups'),
);
console.log('');
