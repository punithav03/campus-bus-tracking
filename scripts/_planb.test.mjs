/**
 * Plan B: the map shows the road the bus actually drove.
 *
 *   node scripts/_planb.test.mjs
 *
 * The scenario this exists for: the Nagalapuram bus turns off the main road at 10.2 km,
 * runs out to Nindra and back to the same junction at 15.1 km. On a morning
 * with nobody waiting, the driver carries straight on. The old engine drew
 * the bus down the spur and back anyway — five kilometres of fiction — and
 * marked both Nindra stops served.
 *
 * Uses the office's demo replay, which feeds the real recorded ride through
 * the same ingest path a phone uses. Replays are never written to the
 * database and never send notifications, so this touches nothing real.
 */
import { B, ensureAccounts, PLAN, PW } from './_fixtures.mjs';
await ensureAccounts();
const NGL = PLAN.find((p) => p.route === 'nagalapuram');
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const login = async (id, pw = PW) => {
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password: pw }),
  });
  const c = r.headers.get('set-cookie');
  return c ? c.split(';')[0] : null;
};
const get = async (p, c) => {
  const r = await fetch(B + p, { headers: c ? { cookie: c } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (p, body, c) => {
  const r = await fetch(B + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const metres = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const adm = await login('admin', process.env.ADMIN_PASSWORD ?? 'svpcet2026');
const stu = await login(NGL.student);     // a Nagalapuram-bus student
ok('signed in', !!adm && !!stu);

/**
 * Run a demo replay of route 1 to its end, polling the live state the whole
 * way, and return every view seen plus the final one.
 */
async function replay(skipSpur) {
  await post('/api/trip?route=nagalapuram', { action: 'stop-replay' }, adm);
  const start = await post('/api/trip?route=nagalapuram', { action: 'replay', speed: 120, skipSpur }, adm);
  if (start.status !== 200) return { start, views: [], last: null };
  const views = [];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 120_000) {
    const v = await get('/api/state?route=nagalapuram', adm);
    if (v.body?.trip) { views.push(v.body); last = v.body; }
    if (v.body?.trip?.status === 'finished' && !v.body.replaying) break;
    await sleep(250);
  }
  return { start, views, last };
}

const NINDRA = ['Nindra'];
const stateOf = (v, name) => v?.stops.find((s) => s.name === name)?.state;

// ---------------------------------------------------------------------------
console.log('\n── THE BUS SKIPS NINDRA ──');
{
  const { start, views, last } = await replay(true);
  ok('replay with a skipped spur starts', start.status === 200, JSON.stringify(start.body));
  ok('it cut a spur of several minutes', (start.body.skippedSpurS ?? 0) > 300,
    String(start.body.skippedSpurS));
  ok('the run finishes', last?.trip?.status === 'finished', last?.trip?.status);

  for (const n of NINDRA) ok(`${n} is SKIPPED, not served`, stateOf(last, n) === 'skipped', stateOf(last, n));
  ok('skipped stops have no arrival time',
    NINDRA.every((n) => last?.stops.find((s) => s.name === n)?.arrivedAt == null));
  ok('skipped stops count as behind the bus', NINDRA.every((n) => last?.stops.find((s) => s.name === n)?.passed));
  // A skipped-stop push is only sent when the bus went by well clear of the
  // stop. Nindra: the bus never came within 1.9 km — certain, so it is pushed.
  ok('Nindra was bypassed by over 500 m, so students there are told',
    NINDRA.every((n) => (last?.stops.find((s) => s.name === n)?.skippedByM ?? 0) >= 500),
    NINDRA.map((n) => last?.stops.find((s) => s.name === n)?.skippedByM).join(','));
  // Narayanavanam Bypass is pinned where the KVB Puram bus was recorded
  // standing. This older ride went through the town instead, a few hundred
  // metres away: shown as skipped, but too close to tell anyone it was.
  const nar = last?.stops.find((s) => s.name === 'Narayanavanam Bypass');
  ok(`a near miss (${nar?.skippedByM} m) is never pushed`,
    nar?.state !== 'skipped' || ((nar?.skippedByM ?? 0) > 0 && nar.skippedByM < 500), JSON.stringify(nar?.skippedByM));

  // The headline property. Every position the map was ever given must be on
  // the main road — never out on the spur. The Nindra stops are 1.9 km and
  // 2.4 km from the junction, so anywhere near them is the fiction back.
  const nStops = last.stops.filter((s) => NINDRA.includes(s.name));
  const closest = Math.min(...views.flatMap((v) => nStops.map((s) => metres(v.trip, s))));
  ok(`the bus was never drawn on the spur (closest ${Math.round(closest)} m to a Nindra stop)`,
    closest > 800, `${Math.round(closest)} m`);

  // ETAs downstream must drop the moment the skip is seen, not crawl down
  // as if the bus were driving the spur.
  const before = views.find((v) => stateOf(v, 'Nindra') === 'upcoming' &&
    v.trip.distAlongM > 9000 && v.trip.distAlongM < 10300);
  const after = views.find((v) => stateOf(v, 'Nindra') === 'skipped');
  const kb = (v) => v?.stops.find((s) => s.name === 'Palamangalam')?.etaS;
  if (before && after && kb(before) != null && kb(after) != null) {
    // ETAs are shown in wall-clock time, so at 120x replay a real minute is half a second.
    const real = (s) => `${Math.round((s * 120) / 60)} min`;
    // The spur is about ten minutes of driving; the ETA must lose most of it
    // at once rather than counting it down.
    ok(`Palamangalam ETA drops when the skip is seen (${real(kb(before))} -> ${real(kb(after))} at real speed)`,
      ((kb(before) - kb(after)) * 120) / 60 >= 6, `${kb(before)} -> ${kb(after)}`);
  } else {
    ok('saw the moment of the skip', false, `before=${!!before} after=${!!after}`);
  }

  // Everything else on the route is untouched by the skip.
  for (const name of ['Ramagiri', 'Keelapudi', 'Palamangalam', 'Chittoor Kandriga', 'Puttur', 'SVPCET']) {
    ok(`${name} still served`, stateOf(last, name) === 'served', stateOf(last, name));
  }

  // "Travelled" is road driven, so it must not include the spur.
  ok(`distance driven excludes the spur (${(last.trip.drivenM / 1000).toFixed(1)} km)`,
    last.trip.drivenM > 30000 && last.trip.drivenM < 39000, String(last.trip.drivenM));
}

// ---------------------------------------------------------------------------
console.log('\n── THE BUS DRIVES NINDRA (same ride, nothing cut) ──');
{
  const { last, views } = await replay(false);
  for (const n of NINDRA) ok(`${n} is served`, stateOf(last, n) === 'served', stateOf(last, n));
  const nStops = last.stops.filter((s) => NINDRA.includes(s.name));
  const closest = Math.min(...views.flatMap((v) => nStops.map((s) => metres(v.trip, s))));
  ok(`and the bus WAS drawn out at Nindra (${Math.round(closest)} m)`, closest < 150, `${Math.round(closest)} m`);
  ok(`distance driven includes the spur (${(last.trip.drivenM / 1000).toFixed(1)} km)`,
    last.trip.drivenM > 39000, String(last.trip.drivenM));
}

// ---------------------------------------------------------------------------
console.log('\n── THE TRAIL ──');
{
  const full = await get('/api/trail?route=nagalapuram&trip=&n=0', adm);
  ok('trail endpoint answers', full.status === 200, String(full.status));
  const pts = (full.body.add ?? []).reduce((a, p) => a + p.pts.length, 0);
  ok(`a whole run is a few thousand road points (${pts})`, pts > 1000 && pts === full.body.n,
    `${pts} vs n=${full.body.n}`);
  ok('it is matched road, not raw GPS',
    (full.body.add ?? []).filter((p) => p.kind === 'road').reduce((a, p) => a + p.pts.length, 0) > pts * 0.95);
  ok('first fetch is a reset', full.body.reset === true);

  const again = await get(`/api/trail?route=nagalapuram&trip=${encodeURIComponent(full.body.tripId)}&n=${full.body.n}`, adm);
  ok('a caller already up to date gets nothing more', again.body.reset === false &&
    (again.body.add ?? []).reduce((a, p) => a + p.pts.length, 0) === 0,
    JSON.stringify(again.body).slice(0, 120));

  const part = await get(`/api/trail?route=nagalapuram&trip=${encodeURIComponent(full.body.tripId)}&n=${full.body.n - 10}`, adm);
  ok('a caller ten points behind gets exactly ten',
    (part.body.add ?? []).reduce((a, p) => a + p.pts.length, 0) === 10);

  const wrong = await get('/api/trail?route=nagalapuram&trip=someone-else&n=50', adm);
  ok('a caller holding another trip gets the whole trail again', wrong.body.reset === true &&
    (wrong.body.add ?? []).reduce((a, p) => a + p.pts.length, 0) === full.body.n);

  ok('signed-out callers are refused', (await get('/api/trail?route=nagalapuram')).status === 401);

  // Route comes from the session for a student — asking for another route's
  // trail by query string gets your own route's trail, never theirs.
  const mine = await get('/api/trail?route=tirupati&trip=&n=0', stu);
  ok("a student cannot read another route's trail", mine.status === 200 &&
    (mine.body.tripId ?? '').startsWith('nagalapuram'), mine.body.tripId);
}

// ---------------------------------------------------------------------------
console.log('\n── STATE CARRIES THE NEW FIELDS ──');
{
  const v = (await get('/api/state?route=nagalapuram', adm)).body;
  ok('trip says whether it is on its route', typeof v.trip?.onRoute === 'boolean');
  ok('trip says whether its position is road-matched', typeof v.trip?.matched === 'boolean');
  ok('every stop has a state', v.stops.every((s) => ['served', 'skipped', 'likely-skipped', 'upcoming'].includes(s.state)));
  ok('trailN matches the trail', v.trip?.trailN > 1000);
}

await post('/api/trip?route=nagalapuram', { action: 'stop-replay' }, adm);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
