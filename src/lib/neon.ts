/**
 * DRAFT — pg.Pool-backed replacement for src/lib/neon.ts.
 *
 * Connects to any vanilla PostgreSQL over TCP (Supabase self-hosted,
 * RDS, etc.), preserving the public surface that the rest of the app
 * depends on:
 *
 *   - `sql\`...\`` tagged template returning rows
 *   - `sql.transaction([q1, q2])` array form (Neon-style batching)
 *   - `sql.transaction((tx) => [q1, q2], { isolationLevel })` callback form
 *   - `transaction((tx) => [...])` helper re-export (unchanged call sites)
 *   - `withTransaction(async (tx) => {...})` sequential helper (unchanged)
 *   - `fmtDate()` and `DbRow`
 *
 * Deployment cut-over: rename this file to `neon.ts` once the rewrite
 * passes type-check + integration tests.
 */

import pg from 'pg';
import { log } from '@/lib/logger';

// Matches the shape the Neon driver returned to the rest of the codebase —
// `NeonQueryFunction<false, false>` yields `Record<string, any>[]`. Keeping
// `any` for values preserves existing call-site ergonomics; tighten per-row
// types by parameterising `sql<Row>\`...\`` where it matters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbRow = Record<string, any>;

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Please configure it in your environment.');
  }
  return url;
}

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: getDatabaseUrl(),
      max: Number(process.env.PG_POOL_MAX ?? 10),
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      // Supabase self-hosted uses self-signed certs; flip DATABASE_SSL=strict
      // to enforce CA verification when moving to a properly-certified host.
      ssl:
        process.env.DATABASE_SSL === 'strict'
          ? { rejectUnauthorized: true }
          : process.env.DATABASE_SSL === 'disable'
            ? false
            : { rejectUnauthorized: false },
    });
    _pool.on('error', (err) => {
      log.warn('pg pool background error', { message: err.message }, 'DB');
    });
  }
  return _pool;
}

interface TransactionOptions {
  isolationLevel?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  readOnly?: boolean;
  deferrable?: boolean;
}

/**
 * Lazy result of a tagged-template call. Awaiting it runs the query against
 * the module-level pool; collecting many into an array and handing them to
 * `sql.transaction([...])` runs them atomically on a single tx client.
 */
class LazyQuery<T = DbRow> implements Promise<T[]> {
  readonly [Symbol.toStringTag] = 'LazyQuery';

  constructor(
    public readonly text: string,
    public readonly values: unknown[],
    private readonly boundClient?: pg.PoolClient
  ) {}

  private async run(): Promise<T[]> {
    if (this.boundClient) {
      const res = await this.boundClient.query(this.text, this.values);
      return res.rows as T[];
    }
    // If a request-scoped tx is in flight, route through it so RLS sees the GUCs.
    const ctxClient = (await import('@/lib/als')).als.getStore()?.client;
    if (ctxClient) {
      const res = await ctxClient.query(this.text, this.values);
      return res.rows as T[];
    }
    const res = await getPool().query(this.text, this.values);
    return res.rows as T[];
  }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T[] | TResult> {
    return this.run().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T[]> {
    return this.run().finally(onfinally);
  }
}

/**
 * Build a parameterised query from a tagged-template call. Interpolated
 * `LazyQuery` values (from `sql\`nested\`` or `sql.unsafe(raw)`) are spliced
 * in as raw fragments with their own `$N` placeholders renumbered to sit
 * alongside the surrounding query's parameters.
 */
function buildQuery(
  strings: TemplateStringsArray,
  values: unknown[]
): { text: string; values: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof LazyQuery) {
        const offset = params.length;
        const renumbered = v.text.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
        text += renumbered;
        params.push(...v.values);
      } else {
        params.push(v);
        text += `$${params.length}`;
      }
    }
  }
  return { text, values: params };
}

function isolationClause(level: TransactionOptions['isolationLevel']): string {
  switch (level) {
    case 'ReadCommitted':
      return 'ISOLATION LEVEL READ COMMITTED';
    case 'RepeatableRead':
      return 'ISOLATION LEVEL REPEATABLE READ';
    case 'Serializable':
      return 'ISOLATION LEVEL SERIALIZABLE';
    default:
      return '';
  }
}

interface SqlFunction {
  <T = DbRow>(strings: TemplateStringsArray, ...values: unknown[]): LazyQuery<T>;
  transaction<T = unknown>(
    queries: LazyQuery<unknown>[] | ((tx: SqlFunction) => LazyQuery<unknown>[]),
    options?: TransactionOptions
  ): Promise<T[][]>;
  /** Raw SQL fragment — awaitable as a query, interpolatable as a splice. */
  unsafe<T = DbRow>(text: string, values?: unknown[]): LazyQuery<T>;
  /** Parameterised raw query — equivalent to pg's `client.query(text, values)`. */
  query<T = DbRow>(text: string, values?: unknown[]): LazyQuery<T>;
}

function createSql(client?: pg.PoolClient): SqlFunction {
  const fn = (<T = DbRow>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const { text, values: params } = buildQuery(strings, values);
    return new LazyQuery<T>(text, params, client);
  }) as SqlFunction;

  fn.unsafe = <T = DbRow>(text: string, values: unknown[] = []) =>
    new LazyQuery<T>(text, values, client);

  fn.query = fn.unsafe;

  fn.transaction = async <T = unknown>(
    queries: LazyQuery<unknown>[] | ((tx: SqlFunction) => LazyQuery<unknown>[]),
    options: TransactionOptions = {}
  ): Promise<T[][]> => {
    const pool = getPool();
    const txClient = await pool.connect();
    try {
      const clauses: string[] = ['BEGIN'];
      const iso = isolationClause(options.isolationLevel);
      if (iso) clauses.push(iso);
      if (options.readOnly) clauses.push('READ ONLY');
      if (options.deferrable) clauses.push('DEFERRABLE');
      await txClient.query(clauses.join(' '));

      const list =
        typeof queries === 'function' ? queries(createSql(txClient)) : queries;

      const results: T[][] = [];
      for (const q of list) {
        const res = await txClient.query(q.text, q.values);
        results.push(res.rows as T[]);
      }

      await txClient.query('COMMIT');
      return results;
    } catch (err) {
      try {
        await txClient.query('ROLLBACK');
      } catch {
        // ROLLBACK failure is secondary to the original error; swallow.
      }
      log.error(
        'sql.transaction rolled back',
        err instanceof Error ? { message: err.message } : { error: err },
        'DB'
      );
      throw err;
    } finally {
      txClient.release();
    }
  };

  return fn;
}

export const sql = createSql();

/**
 * Callback-form helper preserved for existing `transaction((sql) => [...])`
 * call sites. Executes with READ COMMITTED isolation by default.
 */
export async function transaction(
  queriesFn: (txSql: SqlFunction) => LazyQuery[]
): Promise<unknown[][]> {
  return sql.transaction((tx) => queriesFn(tx), {
    isolationLevel: 'ReadCommitted',
  });
}

export type TxSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export async function withTransaction<T>(
  fn: (tx: TxSql) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tx: TxSql = async (strings, ...values) => {
      const { text, values: params } = buildQuery(strings, values);
      const res = await client.query(text, params);
      return res.rows as unknown[];
    };

    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK failure is secondary to the original error; swallow.
    }
    log.error(
      'withTransaction rolled back',
      err instanceof Error ? { message: err.message } : { error: err },
      'DB'
    );
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a SAVEPOINT on the current request-scoped transaction.
 *
 * Why this exists: `withAuth` wraps every request in a single BEGIN/COMMIT
 * so RLS GUCs persist for the whole handler. A single failed query then
 * poisons the whole transaction ("current transaction is aborted …") and
 * every subsequent query in the same request returns a 500 — even when the
 * caller caught the error and wanted to continue with a fallback.
 *
 * `withSavepoint` is the safe way to write defensive reads:
 *
 *   const details = await withSavepoint('company_lookup', async () => {
 *     const rows = await sql`SELECT * FROM companies WHERE …`;
 *     return rows[0];
 *   }).catch(() => null);   // savepoint rolled back cleanly; outer tx fine
 *
 * Outside of a request tx (e.g. cron code), this degrades to a plain
 * `fn()` call — no savepoint needed because each bare `sql\`…\`` opens its
 * own connection.
 */
export async function withSavepoint<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(name)) {
    throw new Error(`withSavepoint: invalid savepoint name ${name}`);
  }
  const ctxClient = (await import('@/lib/als')).als.getStore()?.client;
  if (!ctxClient) {
    // No outer tx — just run; errors propagate as usual.
    return fn();
  }
  await ctxClient.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await ctxClient.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    try {
      await ctxClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await ctxClient.query(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // If the rollback itself fails the outer tx is already doomed — let
      // the original error bubble up so the request returns a real 500.
    }
    throw err;
  }
}

/**
 * Format a value from a DB date column as YYYY-MM-DD, robust to Date
 * objects and strings. Unchanged from the Neon implementation — the pg
 * driver also returns `date` columns as JavaScript Date.
 */
export function fmtDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val);
  if (s.includes('T')) return s.split('T')[0]!;
  return s;
}

export default sql;
