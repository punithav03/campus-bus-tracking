const B = 'http://localhost:3100';
let pass = 0; let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const login = async (id, pw) => {
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password: pw }),
  });
  const c = r.headers.get('set-cookie');
  return { status: r.status, cookie: c ? c.split(';')[0] : null, body: await r.json().catch(() => ({})) };
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

console.log('\n── AUTH ──');
const stu = await login('21CS002', '21CS002');          // route-2
const stu1 = await login('21CS001', '21CS001');         // route-1
const drv = await login('8686288604', '8686288604');    // route-2
const adm = await login('admin', process.env.ADMIN_PASSWORD ?? 'svpcet2026');
ok('student signs in', stu.status === 200 && stu.body.user?.role === 'student');
ok('driver signs in', drv.status === 200 && drv.body.user?.role === 'driver');
ok('admin signs in', adm.status === 200 && adm.body.user?.role === 'admin');

// Unique ids each run: the lockout counts failures per id and persists, so a
// fixed id would be locked out by the fifth run and report 429 instead of 401.
const bad = await login('21CS002', `nope${Date.now()}`);
const unknown = await login(`ZZ${Date.now().toString().slice(-8)}`, 'nope');
ok('wrong password rejected', bad.status === 401);
ok('unknown id rejected', unknown.status === 401);
ok('same message for both', bad.body.error === unknown.body.error, `${bad.body.error} / ${unknown.body.error}`);

console.log('\n── SESSION INTEGRITY ──');
const parts = stu.cookie.split('=')[1].split('.');
const forged = 'svpcet_session=' + parts[0] + '.' +
  Buffer.from(JSON.stringify({ sub: '21CS002', role: 'admin', name: 'x', routeId: null, jti: '1', iat: 1, exp: 9e9 })).toString('base64url') +
  '.' + parts[2];
ok('forged admin cookie rejected', (await get('/api/auth/me', forged)).body.user === null);
ok('garbage cookie rejected', (await get('/api/auth/me', 'svpcet_session=abc.def.ghi')).body.user === null);

console.log('\n── ROUTE ISOLATION ──');
// The server picks the direction from the clock: in the afternoon "my route"
// is the run home, served as route-N@in. These checks care which BUS it is,
// not which way it is pointing, so compare the base id.
const base = (id) => (id ?? '').replace(/@in$/, '');
ok('anon /api/state 401', (await get('/api/state')).status === 401);
ok('anon /api/network 401', (await get('/api/network')).status === 401);
const s2 = await get('/api/state', stu.cookie);
ok('student gets own route', base(s2.body.route?.id) === 'route-2', JSON.stringify(s2.body.route?.id));
const s2b = await get('/api/state?route=route-1', stu.cookie);
ok('student cannot switch route', base(s2b.body.route?.id) === 'route-2', JSON.stringify(s2b.body.route?.id));
const n2 = await get('/api/network', stu.cookie);
ok('student sees exactly 1 route', n2.body.routes?.length === 1);
const nA = await get('/api/network', adm.cookie);
ok('admin sees 3 routes', nA.body.routes?.length === 3);
ok('student cannot read route-1 geometry', (await get('/api/route/route-1', stu.cookie)).status === 403);
ok('student can read own geometry', (await get('/api/route/route-2', stu.cookie)).status === 200);
ok('admin can read any geometry', (await get('/api/route/route-3', adm.cookie)).status === 200);

console.log('\n── DRIVER PRIVACY ──');
const t2 = await get('/api/me/transport', stu.cookie);
const t1 = await get('/api/me/transport', stu1.cookie);
ok('route-2 student sees Eswar', t2.body.driver?.name === 'Eswar');
ok('route-1 student sees Sudhakar', t1.body.driver?.name === 'Sudhakar');
const leak = JSON.stringify(t2.body);
ok('no other driver number in payload',
  !leak.includes('9550085083') && !leak.includes('9573061292'));

console.log('\n── WRITE GUARDS ──');
ok('anon cannot start a trip', (await post('/api/trip', { action: 'start' })).status === 401);
ok('anon cannot ping', (await post('/api/ping', { pings: [{ lat: 1, lng: 1, t: Date.now() }] })).status === 401);
ok('student cannot start a trip', (await post('/api/trip', { action: 'start' }, stu.cookie)).status === 403);
ok('student cannot ping', (await post('/api/ping', { pings: [{ lat: 1, lng: 1, t: Date.now() }] }, stu.cookie)).status === 403);
ok('student cannot read fleet', (await get('/api/admin/fleet', stu.cookie)).status === 403);
ok('driver cannot read fleet', (await get('/api/admin/fleet', drv.cookie)).status === 403);
ok('admin can read fleet', (await get('/api/admin/fleet', adm.cookie)).status === 200);
ok('driver cannot replay', (await post('/api/trip', { action: 'replay' }, drv.cookie)).status === 403);

console.log('\n── DRIVER OWNS ONE BUS ──');
// Ask the route-2 driver to start route-1 and prove the server ignored the
// routeId. Asserting "route-1 is not live" globally would be wrong: another
// bus may legitimately be running, and the test would blame this request for
// it. What matters is which trip THIS driver got.
const openedBy = await post('/api/trip', { routeId: 'route-1', action: 'start' }, drv.cookie);
ok('start succeeds', openedBy.status === 200, JSON.stringify(openedBy.body));
const mine = await get('/api/state', drv.cookie);
ok('driver got his own route, not the one he asked for',
  base(mine.body.route?.id) === 'route-2', `served ${mine.body.route?.id}`);
await post('/api/trip', { action: 'end' }, drv.cookie);

console.log('\n── CSV IMPORT ──');
// A fresh roll number each run. Re-importing an existing student deliberately
// does NOT reset their password, so reusing one would fail on the second run
// and look like a bug in the app rather than in the test.
const TEST_ROLL = `ZZTEST${Date.now().toString().slice(-7)}`;
const badCsv = await post('/api/admin/students',
  { csv: 'roll_no,name,route_id,stop_id\n22CS001,A,route-9,route-9-x' }, adm.cookie);
ok('bad route rejected', badCsv.status === 400 && /unknown route/.test(JSON.stringify(badCsv.body.details)));
const crossCsv = await post('/api/admin/students',
  { csv: '22CS002,B,route-2,route-1-pichatur' }, adm.cookie);
ok('stop on wrong route rejected', crossCsv.status === 400);
const dupCsv = await post('/api/admin/students',
  { csv: '22CS003,C,route-2,route-2-tiruchanoor\n22CS003,C,route-2,route-2-tiruchanoor' }, adm.cookie);
ok('duplicate roll rejected', dupCsv.status === 400);
const goodCsv = await post('/api/admin/students',
  { csv: `roll_no,name,route_id,stop_id\n${TEST_ROLL},Test One,route-3,route-3-renigunta` }, adm.cookie);
ok('valid row imported', goodCsv.status === 200 && goodCsv.body.total === 1);
const newStu = await login(TEST_ROLL, TEST_ROLL);
ok('imported student can sign in', newStu.status === 200);
ok('imported student must change password', newStu.body.user?.mustChangePassword === true);
ok('student cannot import', (await post('/api/admin/students', { csv: 'x' }, stu.cookie)).status === 403);

console.log('\n── PASSWORD CHANGE ──');
const ch = await post('/api/auth/password', { current: TEST_ROLL, next: 'busdemo123' }, newStu.cookie);
ok('password changed', ch.status === 200);
ok('old password now fails', (await login(TEST_ROLL, TEST_ROLL)).status === 401);
const relog = await login(TEST_ROLL, 'busdemo123');
ok('new password works', relog.status === 200);
ok('flag cleared', relog.body.user?.mustChangePassword === false);
ok('short password refused',
  (await post('/api/auth/password', { current: 'busdemo123', next: 'abc' }, relog.cookie)).status === 400);

// Tidy up. The imported account exists only for this run, and leaving it
// behind quietly inflates the student counts the office sees on the fleet
// screen until someone notices route 3 has seventeen students.
const cleaned = await fetch(`${B}/api/admin/students/${TEST_ROLL}`, {
  method: 'DELETE', headers: { cookie: adm.cookie },
}).then((r) => r.json()).catch(() => ({ deleted: 0 }));
ok('test account cleaned up', cleaned.deleted === 1, JSON.stringify(cleaned));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);