/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing, one savepoint per row. Reconciled transactions (books hygiene),
 * contended rows and failed rows are skipped and counted; the rest commit.
 * The run is marked undone only when NOTHING was skipped — a skipped row is
 * still posted and still carries the run's tag, so "undone" would read as
 * "fully reversed" while it is not. Such a run stays open, and a retry picks
 * up exactly the rows still tagged.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction } from './bankAllocationService';
import { reverseJournalEntry } from '../gl/journalEntryService';
import { isRetryableContention } from '../core/retryableContention';

type Row = DbRow;

export interface UndoResult {
  reversed: number;
  skipped: number;
  /**
   * Rows carrying the run's tag that had nothing left to reverse — neither a
   * matched journal line nor a provisional JE. The product makes them:
   * `unmatchTransaction` and `reverseReconciledTransaction` both clear
   * `matched_journal_line_id` and leave `auto_post_run_id` set, so a user who
   * undoes one line by hand and then undoes the run has one of these. All the
   * undo does for such a row is clear the stale tag, which is not a reversal
   * and must not be counted as one — `reversed` is the number the operator
   * reconciles against.
   */
  alreadyUndone: number;
  /** TRUE only when `skipped` is 0 — the run was recorded undone. */
  undone: boolean;
}

/**
 * Savepoint name for one row of the undo. `withSavepoint` caps names at 31
 * characters, so this is a constant rather than an interpolation.
 */
const UNDO_ROW_SAVEPOINT = 'auto_post_undo_line';

export async function undoRun(companyId: string, runId: string, userId: string): Promise<UndoResult> {
  const runRows = (await sql`
    SELECT id, undone_at FROM bank_auto_post_runs
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  if (runRows.length === 0) throw new Error(`Auto-post run ${runId} not found`);
  if (runRows[0]!.undone_at) throw new Error('Run already undone');

  const txRows = (await sql`
    SELECT id, status, matched_journal_line_id, provisional_je_id
    FROM bank_transactions
    WHERE auto_post_run_id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  let reversed = 0;
  let skipped = 0;
  let alreadyUndone = 0;
  let contention: unknown = null;

  for (const tx of txRows) {
    const txId = String(tx.id);
    if (String(tx.status) === 'reconciled') {
      skipped += 1;
      continue;
    }
    try {
      // Under its own savepoint, like the sibling sweep in autoPostGateService.
      // The body posts contra journals and takes row locks under a 5s
      // lock_timeout, so a contended or constraint-violating row raises a REAL
      // Postgres error inside the request transaction. Bare, the catch below
      // swallowed it while the transaction stayed aborted: every later row then
      // failed 25P02 and the trailing `undone` UPDATE threw — so the catch's own
      // "run will still be marked undone" was false in exactly the case it
      // describes. A savepoint makes one failed row roll back alone.
      const didReverse = await withSavepoint(UNDO_ROW_SAVEPOINT, async (): Promise<boolean> => {
        if (tx.matched_journal_line_id && tx.provisional_je_id) {
          log.warn(
            'Auto-post tx has both matched line and provisional JE — reversing matched line only',
            { companyId, runId, txId },
            'auto-post-undo',
          );
        }
        let reversedHere = false;
        if (tx.matched_journal_line_id) {
          await reverseReconciledTransaction(companyId, txId, userId);
          reversedHere = true;
        } else if (tx.provisional_je_id) {
          await reverseJournalEntry(companyId, String(tx.provisional_je_id), userId);
          await sql`
            UPDATE bank_transactions
            SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
            WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
          `;
          reversedHere = true;
        }
        await sql`
          UPDATE bank_transactions SET auto_post_run_id = NULL
          WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
        `;
        return reversedHere;
      });
      if (didReverse) {
        reversed += 1;
      } else {
        alreadyUndone += 1;
        log.info(
          'Auto-post undo found a tagged transaction with nothing to reverse — clearing the stale run tag only',
          { companyId, runId, txId },
          'auto-post-undo',
        );
      }
    } catch (err) {
      // The savepoint has rolled this row back alone — including
      // `reverseReconciledTransaction`'s bank-line lock, which it takes on the
      // enclosing transaction — so the request transaction is live and the
      // rows already reversed stand. Contention is skipped like any failure;
      // it is kept only to decide the answer below.
      if (isRetryableContention(err)) {
        contention ??= err;
        log.info('Auto-post undo skipped a contended transaction', { companyId, runId, txId }, 'auto-post-undo');
      } else {
        log.error(
          'Auto-post undo failed for transaction — run stays open; manual reversal required for this tx',
          { companyId, runId, txId, error: err instanceof Error ? err.message : String(err) },
          'auto-post-undo',
        );
      }
      skipped += 1;
    }
  }

  // Nothing written at all, and a peer's lock is why: every savepoint rolled
  // back and reconciled rows are never touched, so re-throwing makes the route
  // answer 409 with nothing committed behind it. Once any row has been written
  // the counts are the answer instead — a 4xx would COMMIT that work under a
  // failure status.
  if (contention !== null && reversed === 0 && alreadyUndone === 0) throw contention;

  const undone = skipped === 0;
  if (undone) {
    await sql`
      UPDATE bank_auto_post_runs
      SET undone_at = NOW(), undone_by = ${userId}::UUID
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  log.info(
    undone ? 'Auto-post run undone' : 'Auto-post run partly undone — run stays open',
    { companyId, runId, reversed, skipped, alreadyUndone },
    'auto-post-undo',
  );
  return { reversed, skipped, alreadyUndone, undone };
}
