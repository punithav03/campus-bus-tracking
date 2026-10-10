#!/usr/bin/env node
/**
 * Creates the schema and fills it from the route files.
 *
 *   node scripts/db-seed.mjs            create + sync routes/stops, add missing people
 *   node scripts/db-seed.mjs --reset    drop everything first (destructive)
 *
 * Idempotent by design: routes and stops are upserted from data/routes/*.json,
 * so re-running after a route rebuild updates positions without touching a
 * single student record.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

// .env.local, without pulling in a dependency for it.
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const DATA = join(process.cwd(), 'data');
const RESET = process.argv.includes('--reset');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});
const q = (text, params = []) => pool.query(text, params).then((r) => r.rows);

const hash = (pw) => bcrypt.hashSync(pw, 10);

/**
 * The office password. A default so a fresh clone works, overridable so a
 * real deployment is not running on one that is printed in a public repo.
 */
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? 'svpcet2026';

// ---------------------------------------------------------------- demo people
// Driver login id is his mobile number — the one thing he will never forget.
const DRIVERS = [
  { id: '9550085083', name: 'Sudhakar', phone: '9550085083', route: 'route-1' },
  { id: '8686288604', name: 'Eswar',    phone: '8686288604', route: 'route-2' },
  { id: '9573061292', name: 'Shankar',  phone: '9573061292', route: 'route-3' },
];

const ADMINS = [
  { id: 'admin', name: 'Transport Office' },
];

// Placeholders until the real roll numbers arrive. Each one boards at a
// different stop on a different route, which is the whole thing to demo.
const STUDENTS = [
  // The three real accounts for the demo — one per route, so each login opens
  // a different bus. Punitha boards at Pichatur on the Nagalapuram line.
  // stop: null — the app asks them to pick it on first sign-in, which is the
  // flow worth showing. The office sets the route; the student sets the stop.
  { roll: '23G01A05J0', name: 'Punitha V',  route: 'route-1', stop: null },
  { roll: '23G01A05B1', name: 'Student B1', route: 'route-2', stop: null },
  { roll: '23G01A05D6', name: 'Student D6', route: 'route-3', stop: null },

  // Spares, for showing two students on one route behaving differently.
  { roll: '21CS001', name: 'Demo Student 1', route: 'route-1', stop: 'route-1-nindra-1' },
  { roll: '21CS002', name: 'Demo Student 2', route: 'route-2', stop: 'route-2-balaji-colony' },
  { roll: '21CS003', name: 'Demo Student 3', route: 'route-3', stop: 'route-3-renigunta' },
];

// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing — check .env.local');
  console.log('host:', process.env.DATABASE_URL.split('@')[1].split('/')[0]);

  if (RESET) {
    console.log('\n!! dropping every table');
    await q(`DROP TABLE IF EXISTS login_attempts, stop_events, trips,
             students, admins, drivers, stops, routes CASCADE`);
  }

  console.log('\nschema…');
  await q(readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8'));
  console.log('  ok');

  // ---- routes + stops, straight from the files the engine reads -----------
  const net = JSON.parse(readFileSync(join(DATA, 'network.json'), 'utf8'));
  console.log('\nroutes…');
  for (const summary of net.routes) {
    const file = join(DATA, 'routes', `${summary.id}.json`);
    if (!existsSync(file)) { console.log(`  ! ${summary.id} has no data file, skipped`); continue; }
    const r = JSON.parse(readFileSync(file, 'utf8'));

    await q(
      `INSERT INTO routes (id, code, name, color, sched_start, length_m, duration_s)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         code=EXCLUDED.code, name=EXCLUDED.name, color=EXCLUDED.color,
         sched_start=EXCLUDED.sched_start, length_m=EXCLUDED.length_m,
         duration_s=EXCLUDED.duration_s`,
      [r.id, r.code, r.name, r.color, r.schedStart, r.lengthM, r.durationS],
    );

    for (const s of r.stops) {
      await q(
        `INSERT INTO stops (id, route_id, seq, name, lat, lng, dist_along_m, sched_offset_s, estimated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           seq=EXCLUDED.seq, name=EXCLUDED.name, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
           dist_along_m=EXCLUDED.dist_along_m, sched_offset_s=EXCLUDED.sched_offset_s,
           estimated=EXCLUDED.estimated`,
        [s.id, r.id, s.seq, s.name, s.lat, s.lng, s.distAlongM, s.schedOffsetS ?? 0, !!s.estimated],
      );
    }
    const est = r.stops.filter((s) => s.estimated).length;
    console.log(`  ${r.id}  ${r.stops.length} stops${est ? ` (${est} estimated)` : ''}  ${(r.lengthM / 1000).toFixed(1)} km`);
  }

  // ---- people -------------------------------------------------------------
  // Passwords are set only when the row is created. Re-running never resets
  // a password somebody has already changed.
  console.log('\ndrivers…');
  for (const d of DRIVERS) {
    const r = await q(
      `INSERT INTO drivers (id, name, phone, password_hash, route_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, phone=EXCLUDED.phone, route_id=EXCLUDED.route_id
       RETURNING (xmax = 0) AS created`,
      [d.id, d.name, d.phone, hash(d.phone), d.route],
    );
    console.log(`  ${d.name.padEnd(10)} ${d.id}  ${d.route}  ${r[0].created ? 'created' : 'updated'}`);
  }

  console.log('\nadmins…');
  for (const a of ADMINS) {
    const r = await q(
      `INSERT INTO admins (id, name, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name
       RETURNING (xmax = 0) AS created`,
      [a.id, a.name, hash(ADMIN_PW)],
    );
    console.log(`  ${a.id}  ${r[0].created ? 'created' : 'updated'}`);
  }

  console.log('\nstudents…');
  for (const s of STUDENTS) {
    if (s.stop) {
      const stopOk = await q('SELECT 1 FROM stops WHERE id=$1', [s.stop]);
      if (!stopOk.length) { console.log(`  ! ${s.roll}: stop ${s.stop} not found, skipped`); continue; }
    }
    const r = await q(
      `INSERT INTO students (roll_no, name, password_hash, route_id, stop_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,false)
       ON CONFLICT (roll_no) DO UPDATE SET
         name=EXCLUDED.name, route_id=EXCLUDED.route_id, stop_id=EXCLUDED.stop_id
       RETURNING (xmax = 0) AS created`,
      [s.roll, s.name, hash(s.roll), s.route, s.stop ?? null],
    );
    console.log(`  ${s.roll}  ${s.route}  ${s.stop ? s.stop.replace(/^route-\d-/, '') : '(asks on first login)'}  ${r[0].created ? 'created' : 'updated'}`);
  }

  // ---- what you can log in with ------------------------------------------
  console.log(`
────────────────────────────────────────────────
  STUDENT   23G01A05J0  route 1 · Pichatur      (Punitha)
            23G01A05B1  route 2 · Tiruchanoor
            23G01A05D6  route 3 · Leela Mahal
            password = the roll number
  DRIVER    9550085083 / 8686288604 / 9573061292
            password = the mobile number
  ADMIN     admin                password = $ADMIN_PASSWORD (default svpcet2026)
────────────────────────────────────────────────`);

  await pool.end();
}

main().catch(async (e) => {
  console.error('\nfailed:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
