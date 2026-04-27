/**
 * Shared Postgres helper for standalone scripts.
 *
 * Post Neon→Supabase cutover (2026-04-18), scripts that previously did:
 *     import { neon } from '@neondatabase/serverless';
 *     const sql = neon(process.env.DATABASE_URL!);
 *
 * should do:
 *     import { createSql } from './_pg';
 *     const sql = createSql();                        // reads process.env.DATABASE_URL
 *     // or: const sql = createSql(SPECIFIC_URL);     // overrides
 *
 * The returned function is a tagged template matching the `neon()` shape:
 *     const rows = await sql`SELECT ... WHERE id = ${id}`;
 *
 * Differences vs `neon()`:
 *   - Speaks vanilla Postgres TCP, works against Supabase/RDS/anywhere.
 *   - Uses a single per-script pg.Pool (cleanup via `closeSql()` if the
 *     script hangs waiting for connections).
 *   - No transaction() / array batching helper — scripts that need it can
 *     pull withTransaction out of src/lib/neon.ts instead.
 */

import pg from 'pg';

let _pools: Map<string, pg.Pool> = new Map();

export function createSql(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set and no connection string was passed.');
  }

  let pool = _pools.get(url);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: url.includes('sslmode=disable')
        ? false
        : { rejectUnauthorized: false },
    });
    _pools.set(url, pool);
  }

  const sql = async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = '';
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) text += `$${i + 1}`;
    }
    const res = await pool!.query(text, values);
    return res.rows as T[];
  };

  // Raw query escape hatch — matches `neon()`'s `.query(text, values?)` shape.
  // Used by migration runners that build multi-statement bodies from files.
  (sql as SqlFunction).query = async <T = Record<string, unknown>>(
    text: string,
    values: unknown[] = []
  ): Promise<T[]> => {
    const res = await pool!.query(text, values);
    return res.rows as T[];
  };

  return sql as SqlFunction;
}

interface SqlFunction {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
}

export async function closeSql(): Promise<void> {
  for (const p of _pools.values()) {
    await p.end();
  }
  _pools.clear();
}

/**
 * Tagged-template SQL function shape — matches `createSql()`'s return value.
 * Exported as the canonical type so callers can pass `sql` around without
 * each module re-declaring its own (and drifting).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TaggedSql = <T = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

/**
 * Run `fn` inside a real Postgres transaction on a single pooled connection.
 * The callback receives a `tx` of the same tagged-template shape as `sql`,
 * but every query runs on the held client (so BEGIN/COMMIT and SET LOCAL
 * actually apply across statements).
 *
 * Plain `sql` from createSql() calls `pool.query` per statement and checks
 * out a fresh connection each time — wrapping bare `BEGIN`/`COMMIT` around
 * such calls is a no-op. Use this helper any time you need atomicity.
 */
export async function withTransactionPg<T>(
  sql: TaggedSql,
  fn: (tx: TaggedSql) => Promise<T>,
): Promise<T> {
  // Warm-up via the passed `sql` so the pool entry exists for the URL key,
  // then look it up directly from the pool registry.
  await sql`SELECT 1 AS warmup`;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('withTransactionPg needs DATABASE_URL');
  const pool = _pools.get(url);
  if (!pool) throw new Error('pg pool not registered for DATABASE_URL');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: TaggedSql = async <R = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<R[]> => {
      let text = '';
      for (let i = 0; i < strings.length; i++) {
        text += strings[i];
        if (i < values.length) text += `$${i + 1}`;
      }
      const res = await client.query(text, values);
      return res.rows as R[];
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* secondary; swallow */ }
    throw err;
  } finally {
    client.release();
  }
}
