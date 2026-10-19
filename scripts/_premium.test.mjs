/**
 * Checks for the features added on top of the core app: persisted trips,
 * push subscriptions and "I am at the stop".
 *
 *   node scripts/_premium.test.mjs
 */
import { B, ensureAccounts, PLAN, PW } from './_fixtures.mjs';
await ensureAccounts();
const KVB = PLAN.find((p) => p.route === 'kvb-puram');
const TPT = PLAN.find((p) => p.route === 'tirupati');
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
const send = async (m, p, body, c) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const stu = await login(KVB.student);     // KVB Puram bus
const drv = await login(KVB.driver);      // KVB Puram driver
const adm = await login('admin', process.env.ADMIN_PASSWORD ?? 'svpcet2026');


console.log('\n── TRIP PERSISTENCE ──');
const started = await send('POST', '/api/trip', { action: 'start' }, drv);
ok('trip starts', started.status === 200 && started.body.tripId > 0, JSON.stringify(started.body));
const tripId = started.body.tripId;
ok('direction recorded', started.body.direction === 'outbound', started.body.direction);
const again = await send('POST', '/api/trip', { action: 'start' }, drv);
ok('starting twice reuses the same trip', again.body.tripId === tripId,
  `${tripId} vs ${again.body.tripId}`);

await send('POST', '/api/ping', {
  pings: [{ lat: 13.533061, lng: 79.738444, spd: 8, acc: 9, t: Date.now() }],
}, drv);
const st = await get('/api/state', drv);
ok('position is live', !!st.body.trip);

const ended = await send('POST', '/api/trip', { action: 'end' }, drv);
ok('trip ends', ended.status === 200);
ok('end returns a run summary field', 'summary' in ended.body);

console.log('\n── PUSH ──');
const push = await get('/api/push', stu);
ok('push is configured', push.body.available === true);
ok('a public key is served', typeof push.body.publicKey === 'string' && push.body.publicKey.length > 60);
const fake = {
  endpoint: `https://example.invalid/test-${Date.now()}`,
  keys: { p256dh: 'BN'.padEnd(87, 'x'), auth: 'abcdefghijklmnop' },
  leadMin: 8,
};
const sub = await send('POST', '/api/push', fake, stu);
ok('device subscribes', sub.status === 200 && sub.body.leadMin === 8);
ok('subscription is listed', (await get('/api/push', stu)).body.devices >= 1);
ok('lead time clamped', (await send('POST', '/api/push', { ...fake, leadMin: 999 }, stu)).body.leadMin === 30);
ok('incomplete subscription rejected',
  (await send('POST', '/api/push', { endpoint: 'x' }, stu)).status === 400);
ok('driver cannot subscribe', (await get('/api/push', drv)).status === 403);
await send('DELETE', '/api/push', { endpoint: fake.endpoint }, stu);
ok('unsubscribe works', (await get('/api/push', stu)).body.devices === 0);

console.log('\n── I AM AT THE STOP ──');
const mark = await send('POST', '/api/me/waiting', {}, stu);
ok('student can mark waiting', mark.status === 200, JSON.stringify(mark.body));
if (mark.status === 200) {
  const seen = await get('/api/driver/waiting', drv);
  ok('driver sees the count', seen.body.total >= 1, JSON.stringify(seen.body));
  ok('driver sees the stop name', (seen.body.stops ?? []).some((s) => s.name));
  ok('no names leak to the driver', !JSON.stringify(seen.body).includes(KVB.student));
  ok('another bus is unaffected',
    (await get('/api/driver/waiting', await login(TPT.driver))).body.total === 0, 'tirupati');
  await send('DELETE', '/api/me/waiting', {}, stu);
  ok('cancelling clears it', (await get('/api/driver/waiting', drv)).body.total === 0);
}
ok('students cannot read the driver panel', (await get('/api/driver/waiting', stu)).status === 403);

/**
 * ── DEAD RECKONING IS CAPPED ───────────────────────────────────────────────
 *
 * A phone that stops uploading must not produce a bus that keeps driving.
 *
 * This is the regression that made the app feel untrustworthy: the engine
 * coasted the marker along the reference curve for four minutes — four
 * kilometres at highway speed — and only called the trip stale after ten. So
 * a driver whose uploads had been throttled into silence still showed as a
 * bus gliding smoothly through villages it was nowhere near.
 *
 * Send one fix at a known speed, then stop. The shown distance must advance
 * by at most COAST_S seconds' worth and then STOP ADVANCING, however long
 * the silence lasts.
 *
 * Costs about 75 seconds of wall clock, because the thing under test is the
 * passage of real time and there is no way to fake it through the HTTP API.
 */
console.log('\n── DEAD RECKONING IS CAPPED ──  (~75s, it is waiting on the clock)');
{
  // Coasting starts where the 'live' band ends (30s) and stops at 45s, so a
  // silent phone buys at most 15 seconds of extrapolated travel — ever.
  const COAST_S = 45 - 30;
  const SPD = 10;                     // m/s — so the cap is a round 150 m
  await send('POST', '/api/trip', { action: 'start' }, drv);
  await send('POST', '/api/ping', {
    pings: [{ lat: 13.533061, lng: 79.738444, spd: SPD, acc: 8, t: Date.now() }],
  }, drv);

  const shown = async () => (await get('/api/state', drv)).body.trip?.distAlongM ?? null;
  const d0 = await shown();
  ok('a single fix opens the trip', d0 != null, String(d0));

  await new Promise((r) => setTimeout(r, 50_000));
  const d1 = await shown();
  await new Promise((r) => setTimeout(r, 20_000));
  const d2 = await shown();

  const cap = COAST_S * SPD;
  ok('coasts forward while the signal is merely late', d1 != null && d1 > d0,
    `${d0} -> ${d1}`);
  ok(`coasts no further than ${cap} m`, d1 != null && d1 - d0 <= cap + 15,
    `advanced ${d1 - d0} m`);
  // The real assertion: twenty more seconds of silence buys no more distance.
  ok('stops coasting once the cap is reached', d1 != null && Math.abs(d2 - d1) <= 5,
    `${d1} -> ${d2}`);
  const conf = (await get('/api/state', drv)).body.trip?.confidence;
  ok('and it is no longer claiming to be live', conf !== 'live', String(conf));

  await send('POST', '/api/trip', { action: 'end' }, drv);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
