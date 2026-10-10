import { Pool } from 'pg';

/**
 * One connection pool for the whole server.
 *
 * Two things matter here and both are easy to get wrong.
 *
 * First, the pool is cached on globalThis. Next's dev server reloads modules on
 * every edit, and a fresh Pool per reload would quietly open connections until
 * Neon refused new ones — a failure that only shows up after twenty minutes of
 * editing and looks like the database went down.
 *
 * Second, the connection string must be the POOLED one (its host contains
 * "-pooler"). Neon's pooler fronts thousands of client connections with a small
 * number of real Postgres backends, which is the only way a few hundred
 * students logging in at 7am does not exhaust the server. We check for it and
 * warn rather than fail, because a direct URL still works for local scripts.
 */

const URL = process.env.DATABASE_URL ?? '';

declare global {
  // eslint-disable-next-line no-var
  var __busPool: Pool | undefined;
}

function create(): Pool {
  if (!URL) {
    throw new Error(
      'DATABASE_URL is not set. Copy the pooled connection string from Neon into .env.local.',
    );
  }
  if (!URL.includes('-pooler') && process.env.NODE_ENV === 'production') {
    console.warn('[db] DATABASE_URL is not the pooled endpoint — expect connection limits under load.');
  }

  const pool = new Pool({
    connectionString: URL,
    // Neon requires TLS. It presents a valid cert, but the pooler sits behind a
    // proxy whose chain Node does not always carry, so verification is relaxed
    // while transport stays encrypted.
    ssl: { rejectUnauthorized: false },
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool error with no listener crashes the process. A dropped idle
  // connection is routine — Neon scales to zero — so log it and move on.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  return pool;
}

export const pool: Pool = globalThis.__busPool ?? create();
if (process.env.NODE_ENV !== 'production') globalThis.__busPool = pool;

/** Run a query and get the rows back, typed. */
export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

/** The first row, or null. For lookups by primary key. */
export async function one<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

/** Everything inside, or nothing. */
export async function tx<T>(fn: (q: typeof sql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = async <R>(text: string, params: unknown[] = []) => {
      const res = await client.query(text, params as never[]);
      return res.rows as R[];
    };
    const out = await fn(scoped as typeof sql);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
