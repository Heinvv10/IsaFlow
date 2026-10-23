/**
 * `withTransaction` and `withSavepoint`.
 *
 * Part of `@/lib/neon` (R-184 split the former 475-line src/lib/neon.ts). Import
 * it ONLY from the barrel src/lib/neon.ts and its sibling modules: every other
 * file imports '@/lib/neon', which is what `vi.mock('@/lib/neon', ...)`
 * intercepts (guarded by tests/unit/lib/neonModuleShape.test.ts).
 */

import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { logTransactionRollback } from '@/lib/transactionRefusal';
// See ./query.ts for why als is imported statically.
import { AsyncLocalStorage } from 'node:async_hooks';
import { als, assertTxUsable, markTxUnusable } from '@/lib/als';
import { getPool } from './pool';
import { buildQuery } from './query';

export type TxSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

let withTxSeq = 0;

/**
 * Run `fn` in a transaction.
 *
 * Inside a request (withAuth / withPlatformAdmin / MCP bearer pipeline) a
 * transaction is ALREADY open on the ALS-bound client, so `fn` runs on that
 * client inside a SAVEPOINT: it sees every row the request wrote so far and
 * commits/rolls back with the request. Taking a second pool connection here
 * (the pre-2026-08-27 behaviour) made those rows invisible — every bank
 * allocation failed on `bank_transactions_matched_journal_line_id_fkey` —
 * and COMMITted independently of the request, breaking withAuth's
 * all-or-nothing contract.
 *
 * Outside a request (cron, scripts) it opens its own connection + BEGIN.
 *
 * NEVER call withTransaction concurrently within one request
 * (Promise.all([withTransaction(...), withTransaction(...)])): savepoints on a
 * shared pg connection must nest LIFO (postgresql-gotchas §36). Sequence them.
 */
export async function withTransaction<T>(
  fn: (tx: TxSql) => Promise<T>
): Promise<T> {
  const ctxClient = als.getStore()?.client;
  if (ctxClient) {
    assertTxUsable();
    const tx: TxSql = async (strings, ...values) => {
      const { text, values: params } = buildQuery(strings, values);
      const res = await ctxClient.query(text, params);
      return res.rows as unknown[];
    };
    withTxSeq = (withTxSeq + 1) % 1_000_000;
    try {
      return await withSavepoint(`with_tx_${withTxSeq}`, () => fn(tx));
    } catch (err) {
      logTransactionRollback('withTransaction rolled back (request savepoint)', err);
      throw err;
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  let unusable = false;
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
    unusable = await rollbackFailed(client, 'withTransaction');
    logTransactionRollback(
      unusable ? 'withTransaction failed; its ROLLBACK failed too, connection destroyed' : 'withTransaction rolled back',
      err,
    );
    throw err;
  } finally {
    client.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
  }
}

/**
 * Savepoints on one connection must nest LIFO: two siblings that interleave
 * (`Promise.all` of two reads that each use a savepoint) release each other and
 * abort the request. So siblings on the same connection QUEUE: each nesting
 * level has its own queue per connection, held in `savepointLevel`, and a
 * savepoint opened inside another queues only behind its own siblings (never
 * behind its parent, which would deadlock).
 */
type SavepointQueues = Map<object, { tail: Promise<void> }>;
const rootQueues = new WeakMap<object, { tail: Promise<void> }>();
const savepointLevel = new AsyncLocalStorage<SavepointQueues>();

async function queuedOn<T>(client: object, run: () => Promise<T>): Promise<T> {
  const level = savepointLevel.getStore();
  let queue = level?.get(client) ?? rootQueues.get(client);
  if (!queue) { queue = { tail: Promise.resolve() }; rootQueues.set(client, queue); }
  const before = queue.tail;
  let done!: () => void;
  queue.tail = new Promise<void>((resolve) => { done = resolve; });
  await before;
  try {
    const inner: SavepointQueues = new Map(level ?? []);
    inner.set(client, { tail: Promise.resolve() });
    return await savepointLevel.run(inner, run);
  } finally {
    done();
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
  const ctxClient = als.getStore()?.client;
  if (!ctxClient) {
    // No outer tx — just run; errors propagate as usual.
    return fn();
  }
  return queuedOn(ctxClient, () => runInSavepoint(ctxClient, name, fn));
}

async function runInSavepoint<T>(
  ctxClient: { query: (text: string) => Promise<unknown> },
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  assertTxUsable();
  await ctxClient.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await ctxClient.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    try {
      await ctxClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
      // Split from the rollback deliberately. After a SUCCESSFUL rollback the
      // transaction state is restored and the tx is structurally fine, so a
      // failing RELEASE must not poison it — and must not be reported as
      // "the rollback failed", which it did not.
      try {
        await ctxClient.query(`RELEASE SAVEPOINT ${name}`);
      } catch (releaseErr) {
        log.warn(
          'RELEASE SAVEPOINT failed after a successful rollback; transaction left usable',
          { savepoint: name, error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr) },
          'DB',
        );
      }
    } catch (rollbackErr) {
      // The rollback failed, so the connection is genuinely aborted and every
      // later query on it would raise a bare 25P02 that says nothing about WHY.
      //
      // The original error still bubbles — it is the cause worth surfacing, and
      // a caller that lets it propagate gets a real 500 as before. But
      // withSavepoint's documented idiom is to CATCH and carry on
      // (`.catch(() => null)`), and those callers would otherwise issue their
      // next query into the dark. So mark the context: assertTxUsable turns the
      // next query into an error that names this cause.
      markTxUnusable(err, rollbackErr);
    }
    throw err;
  }
}
