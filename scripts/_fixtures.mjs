/**
 * Test accounts, so the test suites never touch a real student or driver.
 *
 *   import { accounts, B } from './_fixtures.mjs'   in a test
 *   node scripts/_fixtures.mjs --cleanup            remove them all
 *
 * Real accounts start with a password everyone can guess (the admission or
 * mobile number) and must change it before the app will do anything for them,
 * so tests cannot borrow them without changing real passwords. Instead every
 * suite gets its own: one student per bus (TEST-<route>) and one driver per bus
 * (0000000001..), written straight into the database the server is using,
 * with a known password and nothing left to change.
 *
 * Refuses to run against anything but a database on this machine unless
 * ALLOW_REMOTE_TEST=1: it writes accounts, and the live database is not the
 * place for them.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

export const B = process.env.BASE ?? 'http://localhost:3100';
export const PW = 'test-pass-1';

const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const URL = process.env.DATABASE_URL ?? '';
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL);

const net = JSON.parse(readFileSync(join(process.cwd(), 'data', 'network.json'), 'utf8'));
export const ROUTES = net.routes.map((r) => r.id);
const route = (id) => JSON.parse(readFileSync(join(process.cwd(), 'data', 'routes', `${id}.json`), 'utf8'));

/** One student and one driver per bus, plus the stop each student boards at. */
export const PLAN = ROUTES.map((id, i) => {
  const r = route(id);
  // A stop in the middle of the route: it has stops before and after it.
  const official = r.stops.filter((s) => !s.extra && s.name !== 'SVPCET');
  const stop = official[Math.floor(official.length / 2)];
  return {
    route: id,
    student: `TEST-${id.toUpperCase()}`,
    driver: String(i + 1).padStart(10, '0'),
    driverName: `Test Driver ${r.code}`,
    stop: stop.id,
    stopName: stop.name,
  };
});

async function withDb(fn) {
  if (!URL) throw new Error('DATABASE_URL is not set');
  if (!local && process.env.ALLOW_REMOTE_TEST !== '1') {
    throw new Error('Tests create accounts. Point DATABASE_URL (for the server AND the tests) at a local database, or set ALLOW_REMOTE_TEST=1.');
  }
  const pool = new pg.Pool({ connectionString: URL, ssl: local ? false : { rejectUnauthorized: false }, max: 2 });
  try { return await fn((t, p = []) => pool.query(t, p).then((r) => r.rows)); } finally { await pool.end(); }
}

let ensured = false;
export async function ensureAccounts() {
  if (ensured) return PLAN;
  const hash = bcrypt.hashSync(PW, 8);
  await withDb(async (q) => {
    for (const p of PLAN) {
      await q(`INSERT INTO students (roll_no, name, password_hash, route_id, stop_id, must_change_password)
               VALUES ($1,$2,$3,$4,$5,false)
               ON CONFLICT (roll_no) DO UPDATE SET password_hash=EXCLUDED.password_hash, route_id=EXCLUDED.route_id,
                 stop_id=EXCLUDED.stop_id, must_change_password=false`,
      [p.student, `Test Student ${p.route}`, hash, p.route, p.stop]);
      await q(`INSERT INTO drivers (id, name, phone, password_hash, route_id, must_change_password)
               VALUES ($1,$2,$1,$3,$4,false)
               ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash, route_id=EXCLUDED.route_id,
                 must_change_password=false, active=true`,
      [p.driver, p.driverName, hash, p.route]);
      await q('DELETE FROM login_attempts WHERE user_id = ANY($1)', [[p.student, p.driver]]);
    }
  });
  ensured = true;
  return PLAN;
}

export async function cleanup() {
  await withDb(async (q) => {
    const s = await q("DELETE FROM students WHERE roll_no LIKE 'TEST-%' RETURNING roll_no");
    const d = await q("DELETE FROM drivers WHERE id LIKE '00000000%' RETURNING id");
    console.log(`removed ${s.length} test students, ${d.length} test drivers`);
  });
}

export async function login(id, pw = PW) {
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password: pw }),
  });
  const c = r.headers.get('set-cookie');
  return { status: r.status, cookie: c ? c.split(';')[0] : null, body: await r.json().catch(() => ({})) };
}

export const adminPassword = () => process.env.ADMIN_PASSWORD ?? 'svpcet2026';

/** Sign in as the test student / driver for a bus. */
export const student = async (routeId) => (await login(PLAN.find((p) => p.route === routeId).student)).cookie;
export const driver = async (routeId) => (await login(PLAN.find((p) => p.route === routeId).driver)).cookie;
export const admin = async () => (await login('admin', adminPassword())).cookie;

if (process.argv.includes('--cleanup')) await cleanup();
