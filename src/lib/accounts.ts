import bcrypt from 'bcryptjs';
import { sql, one } from './db';
import type { Role, Session } from './session';

/**
 * Looking up a user and checking a password.
 *
 * One login box for three kinds of people. A driver should not have to know he
 * is a "driver" and pick the right tab — he types his mobile number and a
 * password, and the server works out what he is. The id spaces cannot collide:
 * roll numbers are alphanumeric, driver ids are ten-digit mobiles, and there is
 * one admin.
 */

export interface Account {
  id: string;
  name: string;
  role: Role;
  routeId: string | null;
  passwordHash: string;
  mustChangePassword: boolean;
}

type Row = {
  id: string; name: string; route_id: string | null;
  password_hash: string; must_change_password: boolean;
};

async function find(id: string): Promise<Account | null> {
  const key = id.trim();
  if (!key) return null;

  // Students first: there are a thousand of them and three of everyone else.
  const s = await one<Row>(
    `SELECT roll_no AS id, name, route_id, password_hash, must_change_password
       FROM students WHERE upper(roll_no) = upper($1)`, [key]);
  if (s) return { ...acct(s, 'student') };

  const d = await one<Row>(
    `SELECT id, name, route_id, password_hash, must_change_password
       FROM drivers WHERE id = $1 AND active`, [key]);
  if (d) return { ...acct(d, 'driver') };

  const a = await one<Omit<Row, 'route_id' | 'must_change_password'>>(
    `SELECT id, name, password_hash FROM admins WHERE lower(id) = lower($1)`, [key]);
  if (a) {
    return {
      id: a.id, name: a.name, role: 'admin', routeId: null,
      passwordHash: a.password_hash, mustChangePassword: false,
    };
  }
  return null;
}

const acct = (r: Row, role: Role): Account => ({
  id: r.id, name: r.name, role, routeId: r.route_id,
  passwordHash: r.password_hash, mustChangePassword: r.must_change_password,
});

/**
 * Too many wrong guesses recently?
 *
 * Counted in the database rather than in memory, because the app may run on
 * more than one instance and an attacker should not get a fresh allowance by
 * being load-balanced somewhere else.
 */
const MAX_FAILS = 5;
const WINDOW_MIN = 10;

export async function isLockedOut(id: string): Promise<boolean> {
  const rows = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM login_attempts
      WHERE user_id = $1 AND NOT ok AND at > now() - interval '${WINDOW_MIN} minutes'`,
    [id.trim()],
  );
  return Number(rows[0]?.n ?? 0) >= MAX_FAILS;
}

async function record(id: string, ok: boolean): Promise<void> {
  await sql('INSERT INTO login_attempts (user_id, ok) VALUES ($1,$2)', [id.trim(), ok]);
  if (ok) {
    await sql(`DELETE FROM login_attempts WHERE user_id = $1 AND NOT ok`, [id.trim()]);
  }
}

export type LoginResult =
  | { ok: true; session: Omit<Session, 'iat' | 'exp' | 'jti'> }
  | { ok: false; reason: 'bad' | 'locked' };

export async function login(id: string, password: string): Promise<LoginResult> {
  const key = (id ?? '').trim();
  if (!key || !password) return { ok: false, reason: 'bad' };

  if (await isLockedOut(key)) return { ok: false, reason: 'locked' };

  const acc = await find(key);

  // Hash even when the user does not exist. Otherwise a missing account answers
  // in 1 ms and a real one in 80 ms, and that gap tells an attacker which roll
  // numbers are real.
  const hash = acc?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const good = bcrypt.compareSync(password, hash);

  if (!acc || !good) {
    await record(key, false);
    return { ok: false, reason: 'bad' };
  }

  await record(key, true);
  const table = acc.role === 'student' ? 'students' : acc.role === 'driver' ? 'drivers' : 'admins';
  const idCol = acc.role === 'student' ? 'roll_no' : 'id';
  await sql(`UPDATE ${table} SET last_login_at = now() WHERE ${idCol} = $1`, [acc.id]);

  return {
    ok: true,
    session: {
      sub: acc.id,
      role: acc.role,
      name: acc.name,
      routeId: acc.routeId,
      mustChangePassword: acc.mustChangePassword,
    },
  };
}

export async function changePassword(
  session: Session, current: string, next: string,
): Promise<{ ok: boolean; error?: string }> {
  if (next.length < 6) return { ok: false, error: 'Use at least 6 characters.' };

  const acc = await find(session.sub);
  if (!acc) return { ok: false, error: 'Account not found.' };
  if (!bcrypt.compareSync(current, acc.passwordHash)) {
    return { ok: false, error: 'Current password is wrong.' };
  }

  const table = acc.role === 'student' ? 'students' : acc.role === 'driver' ? 'drivers' : 'admins';
  const idCol = acc.role === 'student' ? 'roll_no' : 'id';
  const extra = acc.role === 'admin' ? '' : ', must_change_password = false';
  await sql(
    `UPDATE ${table} SET password_hash = $2${extra} WHERE ${idCol} = $1`,
    [acc.id, bcrypt.hashSync(next, 10)],
  );
  return { ok: true };
}
