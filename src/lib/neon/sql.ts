/**
 * `sql`: the tagged template, `sql.transaction` (array and callback form) and
 * the `transaction()` helper.
 *
 * Part of `@/lib/neon` (R-184 split the former 475-line src/lib/neon.ts). Import
 * it ONLY from the barrel src/lib/neon.ts and its sibling modules: every other
 * file imports '@/lib/neon', which is what `vi.mock('@/lib/neon', ...)`
 * intercepts (guarded by tests/unit/lib/neonModuleShape.test.ts).
 */

import type pg from 'pg';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
// See ./query.ts for why als is imported statically.
import { als, assertTxUsable, markTxUnusable } from '@/lib/als';
import { getPool } from './pool';
import { LazyQuery, buildQuery, type DbRow } from './query';

/** Per-process sequence for ALS-batch savepoint names (nested batches must not collide). */
let alsBatchSeq = 0;

interface TransactionOptions {
  isolationLevel?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  readOnly?: boolean;
  deferrable?: boolean;
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
    // Inside a withAuth/withPlatformAdmin request transaction, run the batch
    // on the ALS-bound client so it JOINS that transaction: atomic with the
    // handler's other writes (a later request failure rolls the batch back)
    // and the RLS GUCs (request.jwt.claims) stay visible. The previous
    // behavior — a fresh pool connection with its own BEGIN/COMMIT — silently
    // committed batch writes even when the surrounding request failed, and
    // ran them without the request's RLS claims. Isolation options are
    // ignored on this path: the outer request transaction owns them.
    const ctxClient = (client ? undefined : als.getStore()?.client);
    if (ctxClient) {
      // Fourth path to the request client, and the one that most needs the
      // guard: the per-item loops this savepoint exists for are precisely the
      // callers that catch and carry on.
      assertTxUsable();
      // SAVEPOINT so a failed batch aborts only the batch, not the whole
      // request transaction — callers with per-item try/catch loops (e.g.
      // sageImportService's messy-data groups) must be able to continue
      // after a batch error without "current transaction is aborted".
      const sp = `sp_sqltx_${++alsBatchSeq}`;
      await ctxClient.query(`SAVEPOINT ${sp}`);
      try {
        const list =
          typeof queries === 'function' ? queries(createSql(ctxClient)) : queries;
        const results: T[][] = [];
        for (const q of list) {
          const res = await ctxClient.query(q.text, q.values);
          results.push(res.rows as T[]);
        }
        await ctxClient.query(`RELEASE SAVEPOINT ${sp}`);
        return results;
      } catch (err) {
        try {
          await ctxClient.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        } catch (rollbackErr) {
          // Same reasoning as withSavepoint: the connection is aborted now, so
          // mark the context or the next batch in the loop gets a bare 25P02
          // with this cause gone.
          markTxUnusable(err, rollbackErr);
        }
        throw err;
      }
    }

    const pool = getPool();
    const txClient = await pool.connect();
    let unusable = false;
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
      unusable = await rollbackFailed(txClient, 'sql.transaction');
      log.error(
        unusable ? 'sql.transaction failed; its ROLLBACK failed too, connection destroyed' : 'sql.transaction rolled back',
        err instanceof Error ? { message: err.message } : { error: err },
        'DB'
      );
      throw err;
    } finally {
      txClient.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
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
