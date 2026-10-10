#!/usr/bin/env node
/**
 * Puts the database back into demo condition.
 *
 *   npm run demo:reset
 *
 * Testing drifts the data: passwords get changed, boarding points get picked,
 * demo runs leave trips open. None of that matters until the morning you are
 * showing somebody and a login does not work. One command, run it before you
 * present.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const q = (t, p = []) => pool.query(t, p);

/**
 * The office password. A default so a fresh clone works, overridable so a
 * real deployment is not running on one that is printed in a public repo.
 */
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? 'svpcet2026';

const DEMO = ['23G01A05J0', '23G01A05B1', '23G01A05D6'];

const main = async () => {
  // Passwords back to the roll number / mobile number.
  const students = await q('SELECT roll_no FROM students');
  for (const { roll_no } of students.rows) {
    await q('UPDATE students SET password_hash=$2, must_change_password=false WHERE roll_no=$1',
      [roll_no, bcrypt.hashSync(roll_no, 10)]);
  }
  const drivers = await q('SELECT id FROM drivers');
  for (const { id } of drivers.rows) {
    await q('UPDATE drivers SET password_hash=$2 WHERE id=$1', [id, bcrypt.hashSync(id, 10)]);
  }
  await q('UPDATE admins SET password_hash=$2 WHERE id=$1', ['admin', bcrypt.hashSync(ADMIN_PW, 10)]);
  console.log(`· passwords reset  (${students.rowCount} students, ${drivers.rowCount} drivers, admin)`);

  // The three demo accounts start fresh, so the boarding picker fires.
  const cleared = await q('UPDATE students SET stop_id=NULL WHERE roll_no = ANY($1)', [DEMO]);
  console.log(`· boarding point cleared for ${cleared.rowCount} demo accounts`);

  const trips = await q("UPDATE trips SET status='abandoned', ended_at=now() WHERE status='running'");
  console.log(`· closed ${trips.rowCount} open trips`);

  for (const [t, label] of [['login_attempts', 'lockouts'], ['waiting', 'waiting taps'],
                            ['alerts', 'alerts'], ['notifications_sent', 'sent notifications']]) {
    const r = await q(`DELETE FROM ${t}`);
    console.log(`· cleared ${r.rowCount} ${label}`);
  }

  const ghosts = await q("DELETE FROM students WHERE roll_no LIKE 'ZZTEST%'");
  if (ghosts.rowCount) console.log(`· removed ${ghosts.rowCount} leftover test students`);

  console.log(`
────────────────────────────────────────────────
  STUDENT   23G01A05J0  route 1    (Punitha)
            23G01A05B1  route 2
            23G01A05D6  route 3
            password = the roll number
  DRIVER    9550085083 / 8686288604 / 9573061292
            password = the mobile number
  ADMIN     admin  ·  $ADMIN_PASSWORD (default svpcet2026)
────────────────────────────────────────────────`);
  await pool.end();
};

main().catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });
