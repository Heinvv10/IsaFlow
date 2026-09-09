/**
 * Single-reversal claim for `gl_journal_entries`, and the transaction that
 * makes it safe.
 *
 * `reverseJournalEntry` used to read the original, check `reversed_at`, build
 * and post the contra, and only THEN write `reversed_at`. Two overlapping
 * callers both read NULL, both cleared the guard and both posted a contra, so
 * the reversed accounts ended at the NEGATIVE of the original instead of zero.
 *
 * The fix is to claim the reversal atomically BEFORE anything is written: a
 * status-predicated `UPDATE ... WHERE reversed_at IS NULL` either wins the row
 * or returns zero rows, and the loser never creates a contra at all.
 *
 * That claim is only safe if it cannot outlive the contra it stands for.
 * `reversed_at IS NOT NULL` is read as "this entry is reversed" by the audit
 * trail (`auditTrailLedgerService`, `auditTrailAttribution`), by
 * `bank/agentActivityService`, by `items/depreciationRunPlan` (which EXCLUDES
 * such an entry from a run) and by `ap/supplierPaymentWorkflowService` (which
 * SKIPS the reversal it owes). A claim left behind by a crashed batch would
 * make all of them describe an un-reversed journal as reversed. So the claim
 * and the contra must commit together or not at all — which is what
 * `withReversalTransaction` guarantees for the callers that have no
 * transaction of their own (`scripts/fixes/reverse-cancelled-invoice-journals.ts`
 * runs `reverseJournalEntry` in a bare loop; cron paths do the same).
 *
 * Widening the claim predicate to "reclaimable when no contra exists" was
 * considered and REJECTED: outside a transaction the winner's claim commits and
 * releases the row lock before its contra exists, so the second caller would
 * re-evaluate that predicate as true and claim as well — reopening the exact
 * race for the exact callers the design targets.
 */

import { sql } from '@/lib/neon';
import { withAlsTransaction } from '@/lib/alsTransaction';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import { log } from '@/lib/logger';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the original longer than the 5s
 * `lock_timeout`. The reverse route and the MCP tool return a caught service
 * error's message to the caller, so this wording is what they read.
 */
export class JournalReversalLockTimeoutError extends Error {
  readonly code = 'JOURNAL_REVERSAL_LOCK_TIMEOUT';
  constructor(entryId: string) {
    super(`Journal entry ${entryId} is being reversed by another request — retry in a moment.`);
    this.name = 'JournalReversalLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Run the whole reversal in one transaction that every nested `sql` call joins.
 *
 * Inside a request one is already open on the ALS-bound client and `fn` simply
 * runs on it. Outside one — `scripts/fixes/reverse-cancelled-invoice-journals.ts`
 * runs `reverseJournalEntry` in a bare loop, and cron paths do the same — this
 * opens one and commits or rolls back as a unit. That is what makes the claim
 * crash-safe: a death anywhere between the claim and the posted contra rolls
 * both back, and a rerun repairs the entry instead of finding it permanently
 * marked.
 *
 * The tenant and user are passed through rather than synthesised, so anything
 * nested that reads the request context sees real values.
 */
export function withReversalTransaction<T>(
  actor: { companyId: string; userId: string },
  fn: () => Promise<T>,
): Promise<T> {
  return withAlsTransaction(actor, fn);
}

/**
 * Mark the original as reversed, but only if it is not already. Returns false
 * when another caller got there first — the caller must refuse instead of
 * posting a second contra.
 *
 * The 5s `lock_timeout` is issued per call rather than memoised, because
 * `SET LOCAL` is subtransaction-aware and `ROLLBACK TO SAVEPOINT` restores it
 * to `0` — no timeout at all — on precisely the paths where contention is
 * likeliest. It is also RESTORED afterwards: `SET LOCAL` is scoped to the
 * transaction, not the statement, so leaving it set would make every later
 * statement of the surrounding request abort after 5s with an unmapped `55P03`.
 */
export async function claimJournalReversal(
  companyId: string,
  entryId: string,
  userId: string,
): Promise<boolean> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'claimJournalReversal requires an open transaction — call it through withReversalTransaction. '
      + 'Outside one the claim autocommits and can outlive the contra it stands for.',
    );
  }
  assertTxUsable();
  // set_config(..., is_local => true) rather than SET LOCAL: identical scope,
  // but it takes a parameter, which SET cannot, so the restore below can pass
  // back whatever value was in force.
  const previous = (await client.query("SELECT current_setting('lock_timeout') AS v"))
    .rows[0]?.v as string | undefined;
  await client.query("SELECT set_config('lock_timeout', '5s', true)");
  try {
    const rows = (await sql`
      UPDATE gl_journal_entries
      SET reversed_by = ${userId}::UUID, reversed_at = NOW()
      WHERE id            = ${entryId}::UUID
        AND company_id    = ${companyId}::UUID
        AND reversed_at IS NULL
      RETURNING id
    `) as DbRow[];
    return rows.length > 0;
  } catch (err) {
    if (isLockTimeout(err)) throw new JournalReversalLockTimeoutError(entryId);
    throw err;
  } finally {
    // Restore rather than reset: inside a request the previous value is whatever
    // an outer statement chose, and a transaction-scoped setting does not lapse
    // when this function returns. Guarded, because on a failed claim the
    // connection may already be aborted and a bare await would replace the real
    // error with 25P02.
    try {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [previous ?? '0']);
    } catch (restoreErr) {
      log.error('Failed to restore lock_timeout after reversal claim', { entryId, error: restoreErr }, 'accounting');
    }
  }
}

/**
 * Give the claim back when the contra could not be created.
 *
 * Almost always redundant — `withReversalTransaction` rolls the claim back with
 * everything else — but not when the CALLER is inside a request transaction,
 * catches the failure and goes on to commit. Without this, that request would
 * leave the entry marked reversed with no contra.
 *
 * Best-effort, and deliberately incapable of replacing the error that brought
 * us here: on an already-aborted connection this raises `25P02`, and a bare
 * `await` would hand the caller "current transaction is aborted" instead of the
 * real cause.
 */
export async function releaseJournalReversalClaim(
  companyId: string,
  entryId: string,
): Promise<void> {
  try {
    await sql`
      UPDATE gl_journal_entries
      SET reversed_by = NULL, reversed_at = NULL
      WHERE id         = ${entryId}::UUID
        AND company_id = ${companyId}::UUID
    `;
  } catch (err) {
    log.error(
      'Failed to release journal reversal claim — the surrounding transaction must roll back',
      { entryId, error: err },
      'accounting',
    );
  }
}
