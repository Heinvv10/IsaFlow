/**
 * Serialising two reclassification batches over the same source account.
 *
 * THE RACE. `post_reclassification_batch` reads the candidate lines, decides
 * which are movable, and posts. Two requests can interleave inside that
 * check-then-act window and both post the same batch:
 *
 *   1. Session A: `post_reclassification_batch(49775627 → 5100, key: 'k1')`.
 *   2. Session B, before A commits: same accounts, key `'k2'`.
 *   3. `acquireIdempotencyLock` keys on (company, tool, idempotency_key) — a
 *      DIFFERENT key, so it does not serialise them.
 *   4. Both reads see `already_reclassified = false` on all 414 lines, because
 *      neither transaction has committed its batch rows yet.
 *   5. Both post. R11,318,214.27 moves twice.
 *
 * None of the three duplicate-move guards can close this. `already_reclassified`
 * and `is_reclass_contra` are read-committed reads of rows the peer has not
 * committed; the `(batch_id, source_line_id)` unique index is per BATCH, and two
 * batches have two ids. This is the same shape `bankTxLock.ts` exists for on
 * `allocate_bank_transaction` — an agent retrying under a fresh key after a
 * timeout is the realistic trigger in both cases.
 *
 * WHY ADVISORY AND NOT `FOR UPDATE`. The rows that need protecting are the ones
 * a *future* read will select, and a `FOR UPDATE` over 414 rows does not stop a
 * peer whose window differs by a day from selecting a 415th. The contended
 * resource is the ACCOUNT, not any particular line, so the lock is taken on the
 * account. It is also one round trip rather than a 414-row lock scan.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`), so it releases on COMMIT or
 * ROLLBACK with no unlock path to forget — including when the registry's
 * savepoint unwinds a failed batch.
 */

import { log } from '@/lib/logger';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the lock. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * 10s, not the 5s `bankTxLock` uses: a batch posts up to 500 journals while it
 * holds this, so a peer arriving mid-batch has legitimately longer to wait than
 * one arriving mid-allocation. A literal, never interpolated from a caller
 * value — see the note on the parameter below.
 */
const LOCK_TIMEOUT = '10s';

/**
 * Raised when another batch holds the source account longer than the timeout.
 *
 * Carries a `code` so the MCP layer can tell it from a genuine failure: nothing
 * has been written when this throws, so the caller may simply retry.
 */
export class ReclassSourceLockedError extends Error {
  readonly code = 'RECLASS_SOURCE_LOCKED';
  constructor(accountId: string) {
    super(
      `GL account ${accountId} is being reclassified by another request — retry in a moment. `
      + 'Nothing was posted.',
    );
    this.name = 'ReclassSourceLockedError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Hold an exclusive advisory lock on `(company, source account)` until the end
 * of the request transaction.
 *
 * Throws outside a request transaction rather than locking nothing: on an
 * implicit single-statement transaction `pg_advisory_xact_lock` releases the
 * instant the statement returns, and the caller would believe it was serialised
 * when it was not. The same reasoning, and the same loud failure,
 * `lockBankTransactionForUpdate` uses.
 *
 * The two-argument form takes two `int4`s, so the company scopes the key space
 * and a hash collision can only ever cost an unnecessary wait inside one
 * tenant — never a missed lock, because equal ids always hash equal.
 *
 * `SET LOCAL` is re-issued on every call. It is subtransaction-aware, so a
 * `ROLLBACK TO SAVEPOINT` — which every MCP write tool does on failure —
 * restores the previous value of `0`, meaning no timeout at all. Caching it per
 * connection would leave later locks waiting forever on exactly the paths where
 * contention is likeliest.
 */
export async function lockReclassSource(
  companyId: string,
  sourceAccountId: string,
  /**
   * Overridable ONLY so the contention test can assert the timeout path
   * deterministically instead of waiting ten seconds or accepting whichever of
   * two errors arrives first. No production caller passes it.
   */
  lockTimeout = LOCK_TIMEOUT,
): Promise<void> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockReclassSource requires a request transaction (withAuth / als.run). '
      + 'Outside one, pg_advisory_xact_lock is released immediately and locks nothing.',
    );
  }
  // Raw client, not `sql`: these carry no tenant predicate and are transaction
  // settings rather than queries. `assertTxUsable` first, because a connection
  // aborted by an earlier savepoint rollback would answer with a bare 25P02 and
  // hand the caller the opaque error that check exists to replace.
  assertTxUsable();
  // `set_config(..., is_local => true)` rather than `SET LOCAL`, because the
  // timeout is a parameter here and `SET LOCAL` cannot bind one — the literal
  // form would mean interpolating a value into a statement, which this codebase
  // does not do anywhere, test seam or not.
  await client.query("SELECT set_config('lock_timeout', $1, true)", [lockTimeout]);
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [companyId, sourceAccountId],
    );
  } catch (err) {
    if (isLockTimeout(err)) {
      log.warn(
        'Reclassification source account is locked by another request',
        { companyId, sourceAccountId },
        'accounting',
      );
      throw new ReclassSourceLockedError(sourceAccountId);
    }
    throw err;
  }
}
