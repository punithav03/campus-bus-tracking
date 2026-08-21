/**
 * Recon pass — finds the real catchment around SVPCET, Puttur.
 * Geocodes candidate origin towns via OpenStreetMap/Nominatim, then asks OSRM
 * for the real road distance and drive time from each one to the campus.
 *
 * Output is a table you read to choose which routes are worth building.
 *   node scripts/discover.mjs
 */

const UA = { 'User-Agent': 'CampusBusTracker/0.1 (student project; local use)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(q) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(q);
  const r = await fetch(url, { headers: UA });
  const j = await r.json();
  await sleep(1100); // Nominatim fair-use: max 1 req/sec
  if (!j.length) return null;
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
}

async function drive(from, to) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.code !== 'Ok') return null;
  return { km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 };
}

// Towns and villages plausibly inside a 50 km college catchment around Puttur.
const CANDIDATES = [
  'Puttur, Tirupati district, Andhra Pradesh',
  'Nagari, Tirupati district, Andhra Pradesh',
  'Pichatur, Tirupati, Andhra Pradesh',
  'Nagalapuram, Tirupati, Andhra Pradesh',
  'Satyavedu, Andhra Pradesh',
  'Narayanavanam, Andhra Pradesh',
  'Vadamalapeta, Andhra Pradesh',
  'Karvetinagaram, Andhra Pradesh',
  'Srikalahasti, Andhra Pradesh',
  'Tirupati, Andhra Pradesh',
  'Renigunta, Andhra Pradesh',
  'Tiruttani, Tamil Nadu',
  'Uthukottai, Tamil Nadu',
  'Pakala, Andhra Pradesh',
  'Chittoor, Andhra Pradesh',
  'Vijayapuram, Tirupati, Andhra Pradesh',
];

const campus =
  (await geocode('RVS Nagar, K N Road, Puttur, Andhra Pradesh 517583')) ??
  (await geocode('Puttur, Tirupati district, Andhra Pradesh'));

console.log(`\nCAMPUS  ${campus.lat.toFixed(5)}, ${campus.lng.toFixed(5)}`);
console.log(`        ${campus.label}\n`);
console.log('  town'.padEnd(26) + 'lat'.padEnd(11) + 'lng'.padEnd(11) + 'road km'.padStart(8) + 'drive'.padStart(9));
console.log('  ' + '-'.repeat(62));

for (const q of CANDIDATES) {
  const g = await geocode(q);
  const short = q.split(',')[0];
  if (!g) { console.log('  ' + short.padEnd(26) + 'not found'); continue; }
  const d = await drive(g, campus);
  console.log(
    '  ' + short.padEnd(26) +
    g.lat.toFixed(5).padEnd(11) +
    g.lng.toFixed(5).padEnd(11) +
    (d ? d.km.toFixed(1).padStart(8) : '     n/a') +
    (d ? (d.min.toFixed(0) + ' min').padStart(9) : '')
  );
}
console.log('');
