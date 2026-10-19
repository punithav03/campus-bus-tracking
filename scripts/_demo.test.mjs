/**
 * The demo, end to end.
 *
 * Walks the exact path taken in front of an audience: the office starts a
 * run, and every screen that should react, reacts. It exists because the
 * individual pieces each passed their own checks while the thing you would
 * actually show somebody was broken — the fleet screen lit up and the
 * student's home screen said the bus was not running.
 *
 *   node scripts/_demo.test.mjs
 */
import { B, ensureAccounts, PLAN, PW, ROUTES } from './_fixtures.mjs';
await ensureAccounts();
let pass = 0; let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${extra}`); }
};

const login = async (id, pw = PW) => {
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password: pw }),
  });
  const c = r.headers.get('set-cookie');
  if (!c) throw new Error(`could not sign in as ${id} (${r.status})`);
  return c.split(';')[0];
};
const get = async (p, c) => (await fetch(B + p, { headers: { cookie: c } })).json();
const post = async (p, body, c) => {
  const r = await fetch(B + p, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every bus the college runs, each with a test student boarding mid-route.
const STUDENTS = Object.fromEntries(PLAN.map((p) => [p.route, { roll: p.student, stop: p.stop }]));
const DRIVERS = Object.fromEntries(PLAN.map((p) => [p.route, p.driver]));

const adm = await login('admin', process.env.ADMIN_PASSWORD ?? 'svpcet2026');

// Start clean, or a trip left over from the last run makes everything pass
// for the wrong reason.
for (const r of ROUTES) await post(`/api/trip?route=${r}`, { action: 'stop-replay' }, adm);
await wait(1200);

console.log('\n── BEFORE: nothing should be running ──');
{
  const n = await get('/api/network', adm);
  ok('no bus is live', (n.routes ?? []).every((r) => !r.live),
    (n.routes ?? []).filter((r) => r.live).map((r) => r.id).join(','));
}

for (const routeId of ROUTES) {
  console.log(`\n── ${routeId.toUpperCase()} ──`);
  const { roll, stop } = STUDENTS[routeId];
  const stu = await login(roll);
  const drv = await login(DRIVERS[routeId]);
  await post('/api/me/stop', { stopId: stop }, stu);

  const started = await post(`/api/trip?route=${routeId}`, { action: 'replay', speed: 25 }, adm);
  ok('office can start the demo', started.status === 200, JSON.stringify(started.body));
  ok('it says which kind of trace it used',
    ['recorded', 'synthetic'].includes(started.body.source), started.body.source);

  await wait(6500);

  // ---- the office ------------------------------------------------------
  const net = await get('/api/network', adm);
  const card = (net.routes ?? []).find((r) => r.id === routeId);
  ok('fleet shows it live', !!card?.live);
  ok('fleet knows it is a demo', card?.live?.replaying === true);
  ok('fleet has an arrival time, not a percentage',
    typeof card?.live?.etaEndS === 'number' && card.live.etaEndS > 0, String(card?.live?.etaEndS));
  ok('fleet names the next stop', !!card?.live?.nextStop, card?.live?.nextStop);

  // ---- the student -----------------------------------------------------
  const home = await get('/api/me/transport', stu);
  ok('student home says the bus is running', !!home.live,
    home.live === null ? 'live was null' : '');
  ok('student home names the next stop', !!home.live?.nextStop, home.live?.nextStop);
  ok('student home has a speed for the animation',
    typeof home.live?.speedMps === 'number', String(home.live?.speedMps));
  ok('student sees their own boarding point', home.boarding?.name,
    JSON.stringify(home.boarding?.name));

  const map = await get('/api/state', stu);
  ok('student map has the bus', !!map.trip);
  ok('student map is on their own route', map.route?.id === routeId, map.route?.id);
  ok('student map has stops with times',
    (map.stops ?? []).some((s) => s.etaS != null || s.passed));

  // ---- the driver ------------------------------------------------------
  const dmap = await get('/api/state', drv);
  ok('driver sees the same bus', !!dmap.trip);
  ok('driver is on his own route', dmap.route?.id === routeId, dmap.route?.id);

  // ---- isolation -------------------------------------------------------
  const other = ROUTES.find((r) => r !== routeId);
  const otherStu = await login(STUDENTS[other].roll);
  const om = await get('/api/state', otherStu);
  ok(`a ${other} student is not shown this bus`,
    om.route?.id === other, om.route?.id);

  // ---- stop it ---------------------------------------------------------
  const stopped = await post(`/api/trip?route=${routeId}`, { action: 'stop-replay' }, adm);
  ok('office can stop the demo', stopped.status === 200);
  await wait(1500);

  const after = await get('/api/network', adm);
  const card2 = (after.routes ?? []).find((r) => r.id === routeId);
  ok('fleet goes quiet again', !card2?.live,
    card2?.live ? JSON.stringify(card2.live.confidence) : '');
  const home2 = await get('/api/me/transport', stu);
  ok('student home goes quiet again', !home2.live);
}

console.log('\n── AFTER: everything stopped ──');
{
  const n = await get('/api/network', adm);
  ok('no bus left running', (n.routes ?? []).every((r) => !r.live));
  const h = await get('/api/health', adm);
  ok('the app is still healthy', h.ok === true);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
