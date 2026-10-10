/**
 * Checks for the features added on top of the core app: persisted trips, the
 * return journey, push subscriptions and "I am at the stop".
 *
 *   node scripts/_premium.test.mjs
 */
const B = process.env.BASE ?? 'http://localhost:3100';
let pass = 0; let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const login = async (id, pw = id) => {
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

const stu = await login('23G01A05J0');     // route-1
const drv = await login('9550085083');     // route-1 driver
const adm = await login('admin', process.env.ADMIN_PASSWORD ?? 'svpcet2026');

console.log('\n── RETURN JOURNEY ──');
const out = await get('/api/route/route-1', adm);
const back = await get('/api/route/route-1%40in', adm);
ok('inbound route exists', back.status === 200);
ok('inbound starts at the college',
  back.body.stops?.[0]?.name === 'SVPCET', back.body.stops?.[0]?.name);
ok('inbound ends at the village',
  back.body.stops?.at(-1)?.name === out.body.stops?.[0]?.name);
ok('same length both ways', back.body.lengthM === out.body.lengthM);
ok('inbound starts in the afternoon', back.body.schedStart >= '12:00', back.body.schedStart);
ok('inbound stop distances increase',
  (back.body.stops ?? []).every((s, i, a) => i === 0 || s.distAlongM > a[i - 1].distAlongM));
ok('inbound times increase',
  (back.body.stops ?? []).every((s, i, a) => i === 0 || s.schedOffsetS >= a[i - 1].schedOffsetS));
ok('student cannot read the inbound of another route',
  (await get('/api/route/route-3%40in', stu)).status === 403);

console.log('\n── TRIP PERSISTENCE ──');
const started = await send('POST', '/api/trip', { action: 'start' }, drv);
ok('trip starts', started.status === 200 && started.body.tripId > 0, JSON.stringify(started.body));
const tripId = started.body.tripId;
ok('direction recorded', ['outbound', 'inbound'].includes(started.body.direction));
const again = await send('POST', '/api/trip', { action: 'start' }, drv);
ok('starting twice reuses the same trip', again.body.tripId === tripId,
  `${tripId} vs ${again.body.tripId}`);

await send('POST', '/api/ping', {
  pings: [{ lat: 13.386142, lng: 79.796865, spd: 8, acc: 9, t: Date.now() }],
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
  ok('no names leak to the driver', !JSON.stringify(seen.body).includes('23G01A05J0'));
  const other = await login('23G01A05D6');     // route-3 student
  ok('other route is unaffected',
    (await get('/api/driver/waiting', await login('9573061292'))).body.total === 0, 'route-3');
  void other;
  await send('DELETE', '/api/me/waiting', {}, stu);
  ok('cancelling clears it', (await get('/api/driver/waiting', drv)).body.total === 0);
}
ok('students cannot read the driver panel', (await get('/api/driver/waiting', stu)).status === 403);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
