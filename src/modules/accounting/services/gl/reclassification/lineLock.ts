/**
 * Row-lock helper for the reclassification WRITE path.
 *
 * THE SAME SHAPE `bankTxLock.ts` EXISTS FOR, and deliberately the same
 * instrument. `post_reclassification_batch` reads the candidate lines, decides
 * which are movable, and posts — a check-then-act window two requests can
 * interleave inside:
 *
 *   1. Session A: `post_reclassification_batch(49775627 → 5100, key: 'k1')`.
 *   2. Session B, before A commits: same accounts, key `'k2'`.
 *   3. `acquireIdempotencyLock` keys on (company, tool, idempotency_key) — a
 *      DIFFERENT key, so it does not serialise them.
 *   4. Both reads see `already_reclassified = false` on all 414 lines, because
 *      neither transaction has committed its batch rows yet.
 *   5. Both post. R11,318,214.27 moves twice.
 *
 * None of the three duplicate-move guards can close that on its own.
 * `already_reclassified` and `is_reclass_contra` are read-committed reads of
 * rows the peer has not committed, and the `(batch_id, source_line_id)` unique
 * index is per BATCH — two batches have two ids, so it cannot collide by
 * construction.
 *
 * WHY THE LINES AND NOT THE ACCOUNT. The contended resource IS the set of
 * lines: two batches can only double-move a line they BOTH selected, and that
 * line is locked here. Two batches over non-overlapping windows genuinely do
 * not conflict and are not made to wait for each other. Locking the account
 * instead would serialise them for nothing, and would be a second lock idiom in
 * a repo that already has this one.
 *
 * Since PR #264 every request runs inside a single transaction on the
 * AsyncLocalStorage-bound client, so `FOR UPDATE` taken here is held for the
 * rest of the request: the second request blocks on the rows until the first
 * commits, then RE-READS their settled state and finds them already
 * reclassified. That re-read is the caller's job and it is what makes the lock
 * worth taking — holding it only across the INSERT would protect nothing.
 *
 * Write path ONLY — never call this from `propose_reclassification` or a dry
 * run. Holding locks on 414 posted lines for the length of a preview would
 * block every real batch on them for no benefit.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for a row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another batch holds one of these lines longer than the 5s
 * `lock_timeout`.
 *
 * Carries a `code` so the MCP layer can tell it from a genuine failure: the
 * lock is taken before anything is written, so nothing needs unwinding and the
 * caller may simply retry. The wording is what the agent reads, so it has to
 * say "retry" and say that nothing posted.
 */
export class ReclassLineLockTimeoutError extends Error {
  readonly code = 'RECLASS_LINE_LOCKED';
  constructor(count: number) {
    super(
      `${count} journal line${count === 1 ? ' is' : 's are'} being reclassified by another `
      + 'request — retry in a moment. Nothing was posted.',
    );
    this.name = 'ReclassLineLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Lock every candidate line and hold it to the end of the request transaction.
 * Returns the ids actually locked — a line deleted between the read and this
 * call simply does not come back, and the caller must not move it.
 *
 * `ORDER BY jl.id ... FOR UPDATE` is what makes this deadlock-free, and it
 * works because Postgres puts the `LockRows` node ABOVE the `Sort` — verified
 * on this schema across index-scan, bitmap-scan and seq-scan plans. Every
 * batch therefore acquires in ascending id order, so two overlapping batches
 * queue rather than deadlock (40P01). The same total-order argument
 * `writeBankBulkAllocate` makes when it sorts by transaction id, in one round
 * trip instead of 500.
 *
 * `FOR UPDATE OF jl` and no join: the candidate query LEFT JOINs
 * `fiscal_periods`, and Postgres refuses `FOR UPDATE` on the nullable side of
 * an outer join. Locking is a separate statement over the ids for that reason,
 * and because a lock taken by primary key cannot drift from the rows the caller
 * actually intends to move.
 *
 * Throws outside a request transaction rather than locking nothing: on an
 * implicit single-statement transaction `FOR UPDATE` releases the instant the
 * SELECT returns, and the caller would believe it was serialised when it was
 * not. Same loud failure as `lockBankTransactionForUpdate`.
 *
 * The 5s `lock_timeout` is re-issued on EVERY call, matching `bankTxLock`:
 * `SET LOCAL` is subtransaction-aware, so `ROLLBACK TO SAVEPOINT` — which every
 * MCP write tool does on failure — restores the previous value of `0`, meaning
 * no timeout at all. Caching it per connection would leave later locks waiting
 * forever on exactly the paths where contention is likeliest.
 */
export async function lockReclassLinesForUpdate(
  companyId: string,
  lineIds: readonly string[],
): Promise<string[]> {
  if (lineIds.length === 0) return [];

  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockReclassLinesForUpdate requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  // Issued on the request client directly, not through `sql`: it is a
  // transaction setting rather than a tenant query and carries no parameters.
  // `assertTxUsable` first, because a connection aborted by an earlier failed
  // savepoint rollback would answer this raw query with a bare 25P02 before the
  // guarded SELECT is reached, handing the caller the opaque error that check
  // exists to replace.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT jl.id
        FROM gl_journal_lines jl
       WHERE jl.id         = ANY(${lineIds as string[]}::UUID[])
         AND jl.company_id = ${companyId}::UUID
       ORDER BY jl.id
         FOR UPDATE
    `) as DbRow[];
    return rows.map((r) => String(r.id));
  } catch (err) {
    if (isLockTimeout(err)) {
      log.warn(
        'Reclassification candidate lines are locked by another request',
        { companyId, lineCount: lineIds.length },
        'accounting',
      );
      throw new ReclassLineLockTimeoutError(lineIds.length);
    }
    throw err;
  }
}
