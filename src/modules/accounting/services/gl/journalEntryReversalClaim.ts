/**
 * Single-reversal claim for `gl_journal_entries`.
 *
 * `reverseJournalEntry` used to read the original, check `reversed_at`, build
 * and post the contra, and only THEN write `reversed_at`. Two overlapping
 * callers both read NULL, both cleared the guard and both posted a contra, so
 * the reversed accounts ended at the NEGATIVE of the original instead of zero.
 *
 * The fix is to claim the reversal atomically BEFORE anything is written: a
 * status-predicated `UPDATE ... WHERE reversed_at IS NULL` either wins the row
 * or returns zero rows. That works inside a request transaction (the loser
 * blocks on the row lock, then re-evaluates the predicate against the winner's
 * committed value) and outside one (the statement is its own transaction), so
 * cron jobs and scripts are covered too — unlike a bare `FOR UPDATE`, which
 * releases at statement end when no transaction is open.
 *
 * The loser therefore never creates a contra at all; there is nothing to clean
 * up on its side.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Raised when another request holds the original longer than the 5s `lock_timeout`. */
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
 * Mark the original as reversed, but only if it is not already. Returns false
 * when another caller got there first — the caller must refuse instead of
 * posting a second contra.
 *
 * The 5s `lock_timeout` is issued per call rather than memoised: `SET LOCAL` is
 * subtransaction-aware and `ROLLBACK TO SAVEPOINT` restores it to `0`, which is
 * no timeout at all. It is only meaningful inside a request transaction, so it
 * is skipped when there is none.
 */
export async function claimJournalReversal(
  companyId: string,
  entryId: string,
  userId: string,
): Promise<boolean> {
  const client = als.getStore()?.client;
  if (client) {
    assertTxUsable();
    await client.query("SET LOCAL lock_timeout = '5s'");
  }
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
  }
}

/**
 * Give the claim back when the contra could not be created or posted.
 *
 * Inside a request transaction the whole attempt rolls back and this is
 * redundant; outside one it is what stops a failed reversal from leaving the
 * entry permanently un-reversible. Same shape as the draft-contra DELETE in
 * `reverseJournalEntry`, and predicated on `reversal_of_id IS NULL` on the
 * contra side being unreachable here — this only ever runs before any link-back.
 */
export async function releaseJournalReversalClaim(
  companyId: string,
  entryId: string,
): Promise<void> {
  await sql`
    UPDATE gl_journal_entries
    SET reversed_by = NULL, reversed_at = NULL
    WHERE id         = ${entryId}::UUID
      AND company_id = ${companyId}::UUID
  `;
}
