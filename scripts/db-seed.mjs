#!/usr/bin/env node
/**
 * Creates the schema and fills it with the college's transport data.
 *
 *   node scripts/db-seed.mjs            schema + routes/stops + drivers + students
 *   node scripts/db-seed.mjs --prune    also remove routes, drivers and student
 *                                       accounts that are no longer in the
 *                                       office's lists (the old demo routes)
 *   node scripts/db-seed.mjs --reset    drop every table first (destructive)
 *
 * Sources
 *   data/network.json + data/routes/*.json   routes and stops (npm run routes)
 *   data/official/transport.json             buses and drivers
 *   data/private/students.json               students (gitignored)
 *
 * Idempotent: run it again after the office sends a new list or a route is
 * rebuilt. Passwords are only ever set when an account is created, and a stop
 * a student picked for themselves is kept as long as it is still on their bus.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

// .env.local, without pulling in a dependency for it. The shell wins, so
// DATABASE_URL=postgres://...localhost... seeds a local database instead.
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const DATA = join(process.cwd(), 'data');
const RESET = process.argv.includes('--reset');
const PRUNE = process.argv.includes('--prune');
const URL = process.env.DATABASE_URL ?? '';
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL);

const pool = new pg.Pool({ connectionString: URL, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
const q = (text, params = []) => pool.query(text, params).then((r) => r.rows);
const hash = (pw) => bcrypt.hashSync(pw, 10);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The office's list is in capitals ("RAVI KUMAR REDDY"). On a phone that reads
 * as shouting; "Ravi Kumar Reddy" is how a person writes their own name.
 * Initials stay capitals: "K.SAI KUMAR" -> "K. Sai Kumar".
 */
const properName = (n) => String(n || '').toLowerCase()
  .replace(/\.(?=\S)/g, '. ')
  .replace(/\s+/g, ' ').trim()
  .replace(/(^|[\s(-])([a-z])/g, (_, a, c) => a + c.toUpperCase());

/**
 * The office password. A default so a fresh clone works, overridable so a
 * real deployment is not running on one that is printed in a public repo.
 */
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? 'svpcet2026';
const ADMINS = [{ id: 'admin', name: 'Transport Office' }];

/**
 * Accounts kept although they are not on the office's list: the people who
 * build and look after the app. Never pruned.
 */
const KEEP = [
  { roll: '23G01A05J0', name: 'Punitha V', route: 'kvb-puram', stopName: 'PICHATUR' },
];

async function main() {
  if (!URL) throw new Error('DATABASE_URL missing — check .env.local');
  console.log('database:', URL.split('@')[1]?.split('/')[0] ?? '?');

  if (RESET) {
    console.log('\n!! dropping every table');
    await q(`DROP TABLE IF EXISTS waiting, alerts, notifications_sent, push_subscriptions, trip_path,
             login_attempts, stop_events, trips, students, admins, drivers, stops, routes CASCADE`);
  }

  console.log('\nschema…');
  for (const f of ['schema.sql', '002_premium.sql', '003_trail.sql', '004_official.sql']) {
    await q(readFileSync(join(process.cwd(), 'db', f), 'utf8'));
    console.log('  ' + f);
  }

  // ---- routes + stops, straight from the files the engine reads -----------
  const net = read(join(DATA, 'network.json'));
  const routes = new Map();
  console.log('\nroutes…');
  for (const summary of net.routes) {
    const r = read(join(DATA, 'routes', `${summary.id}.json`));
    routes.set(r.id, r);
    await q('BEGIN');
    try {
      await q(
        `INSERT INTO routes (id, code, name, color, sched_start, length_m, duration_s, bus_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           code=EXCLUDED.code, name=EXCLUDED.name, color=EXCLUDED.color,
           sched_start=EXCLUDED.sched_start, length_m=EXCLUDED.length_m,
           duration_s=EXCLUDED.duration_s, bus_number=EXCLUDED.bus_number`,
        [r.id, r.code, r.name, r.color, r.schedStart, r.lengthM, r.durationS, r.bus?.number ?? null],
      );
      // Stops are renumbered when the office inserts one; move the old numbers
      // out of the way so (route_id, seq) never collides mid-update.
      await q('UPDATE stops SET seq = seq + 10000 WHERE route_id = $1', [r.id]);
      for (const s of r.stops) {
        await q(
          `INSERT INTO stops (id, route_id, seq, name, lat, lng, dist_along_m, sched_offset_s, estimated, verified, extra, sched_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO UPDATE SET
             route_id=EXCLUDED.route_id, seq=EXCLUDED.seq, name=EXCLUDED.name, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
             dist_along_m=EXCLUDED.dist_along_m, sched_offset_s=EXCLUDED.sched_offset_s,
             estimated=EXCLUDED.estimated, verified=EXCLUDED.verified, extra=EXCLUDED.extra,
             sched_time=EXCLUDED.sched_time`,
          [s.id, r.id, s.seq, s.name, s.lat, s.lng, s.distAlongM, s.schedOffsetS ?? 0,
            !!s.estimated, s.verified !== false, !!s.extra, s.time ?? null],
        );
      }
      // A stop that is no longer on the route: students on it are asked again.
      const gone = await q(
        'DELETE FROM stops WHERE route_id = $1 AND NOT (id = ANY($2)) RETURNING id',
        [r.id, r.stops.map((s) => s.id)],
      );
      await q('COMMIT');
      const est = r.stops.filter((s) => s.estimated).length;
      console.log(`  ${r.code}. ${r.id.padEnd(13)} ${String(r.stops.length).padStart(2)} stops${est ? ` (${est} approx)` : ''}  ${(r.lengthM / 1000).toFixed(1)} km${gone.length ? `  removed ${gone.length} old stop(s)` : ''}`);
    } catch (e) {
      await q('ROLLBACK');
      throw e;
    }
  }
  if (PRUNE) {
    const old = await q('DELETE FROM routes WHERE NOT (id = ANY($1)) RETURNING id', [[...routes.keys()]]);
    if (old.length) console.log(`  removed old routes: ${old.map((r) => r.id).join(', ')}`);
  }

  // ---- drivers: login id is the mobile number -----------------------------
  const transport = read(join(DATA, 'official', 'transport.json'));
  console.log('\ndrivers…');
  for (const b of transport.buses) {
    const phone = b.driver.phone;
    if (!phone) { console.log(`  ! ${b.id}: no driver phone on the sheet`); continue; }
    const r = await q(
      `INSERT INTO drivers (id, name, phone, password_hash, route_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, phone=EXCLUDED.phone, route_id=EXCLUDED.route_id, active=true
       RETURNING (xmax = 0) AS created`,
      [phone, b.driver.name, phone, hash(phone), b.id],
    );
    console.log(`  ${b.driver.name.padEnd(12)} ${phone}  ${b.id.padEnd(13)} ${r[0].created ? 'created' : 'updated'}`);
  }
  if (PRUNE) {
    const off = await q('UPDATE drivers SET active = false WHERE active AND NOT (id = ANY($1)) RETURNING id, name',
      [transport.buses.map((b) => b.driver.phone).filter(Boolean)]);
    if (off.length) console.log(`  deactivated: ${off.map((d) => `${d.name} (${d.id})`).join(', ')}`);
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

  // ---- students -----------------------------------------------------------
  const studentsPath = join(DATA, 'private', 'students.json');
  const list = existsSync(studentsPath) ? read(studentsPath).students : [];
  if (!list.length) console.log('\n! data/private/students.json not found — no students loaded');

  /** The stop this student boards at, by the sheet's name or as an extra stop. */
  const stopFor = (st) => {
    const buses = st.bus ? [st.bus] : st.candidates;
    for (const bid of buses) {
      const r = routes.get(bid);
      if (!r) continue;
      if (st.stop) {
        const s = r.stops.find((x) => x.sheetName === st.stop);
        if (s) return { route: bid, stop: s.id };
      }
      const up = st.pickup.toUpperCase();
      const x = r.stops.find((s) => s.extra && s.name.toUpperCase() === up.replace(/\s+/g, ' ')
        || s.extra && s.id === `${bid}-x-${up.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);
      if (x) return { route: bid, stop: x.id, extra: true };
    }
    return { route: st.bus ?? null, stop: null };
  };

  console.log(`\nstudents… (${list.length})`);
  const tally = { created: 0, updated: 0, withStop: 0, extra: 0, noStop: 0, noBus: 0 };
  const seen = [];
  for (const st of list) {
    const { route, stop, extra } = stopFor(st);
    // Read by the office on the fleet screen, next to what the student wrote.
    const review = st.status === 'OK' && stop ? null
      : !route ? "Not on any bus's timetable or road. Which bus?"
      : !stop ? "Not on the timetable and not found on this bus's road. The student picks their stop; confirm it."
      : extra ? "Not on the timetable; found on this bus's road and added as a stop. Confirm the bus stops there."
      : st.note ? `${st.note.charAt(0).toUpperCase()}${st.note.slice(1)}. Confirm.`
      : null;
    const r = await q(
      `INSERT INTO students (roll_no, name, password_hash, route_id, stop_id, must_change_password, class, pickup_text, review)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8)
       ON CONFLICT (roll_no) DO UPDATE SET
         name=EXCLUDED.name, class=EXCLUDED.class, pickup_text=EXCLUDED.pickup_text, review=EXCLUDED.review,
         stop_id = CASE WHEN students.route_id IS NOT DISTINCT FROM EXCLUDED.route_id AND students.stop_id IS NOT NULL
                        THEN students.stop_id ELSE EXCLUDED.stop_id END,
         route_id=EXCLUDED.route_id
       RETURNING (xmax = 0) AS created`,
      [st.adm, properName(st.name), hash(st.adm), route, stop, st.cls || null, st.pickup || null, review],
    );
    seen.push(st.adm);
    tally[r[0].created ? 'created' : 'updated']++;
    if (!route) tally.noBus++; else if (!stop) tally.noStop++; else if (extra) tally.extra++; else tally.withStop++;
  }
  for (const k of KEEP) {
    const r = routes.get(k.route);
    const stop = r?.stops.find((s) => s.sheetName === k.stopName)?.id ?? null;
    await q(
      `INSERT INTO students (roll_no, name, password_hash, route_id, stop_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,false)
       ON CONFLICT (roll_no) DO UPDATE SET name=EXCLUDED.name, route_id=EXCLUDED.route_id,
         stop_id = CASE WHEN students.route_id IS NOT DISTINCT FROM EXCLUDED.route_id AND students.stop_id IS NOT NULL
                        THEN students.stop_id ELSE EXCLUDED.stop_id END`,
      [k.roll, k.name, hash(k.roll), k.route, stop],
    );
    seen.push(k.roll);
  }
  console.log(`  ${tally.created} created, ${tally.updated} updated`);
  console.log(`  ${tally.withStop} on an official stop, ${tally.extra} on an extra stop found on the road,`);
  console.log(`  ${tally.noStop} on a bus but asked to pick their stop, ${tally.noBus} with no bus yet`);
  if (PRUNE) {
    const gone = await q('DELETE FROM students WHERE NOT (upper(roll_no) = ANY($1)) RETURNING roll_no', [seen.map((s) => s.toUpperCase())]);
    if (gone.length) console.log(`  removed accounts not on the list: ${gone.map((g) => g.roll_no).join(', ')}`);
  }

  console.log(`
────────────────────────────────────────────────
  STUDENT   admission number   password = admission number (must change)
  DRIVER    mobile number      password = mobile number (must change)
  ADMIN     admin              password = $ADMIN_PASSWORD (default svpcet2026)
────────────────────────────────────────────────`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('\nfailed:', e.message);
  await q('ROLLBACK').catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
