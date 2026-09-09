/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing. Reconciled transactions are skipped (books hygiene) — the run is
 * still marked undone, with the skip count returned.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction } from './bankAllocationService';
import { reverseJournalEntry } from '../gl/journalEntryService';

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
      log.error(
        'Auto-post undo failed for transaction — run will still be marked undone; manual reversal required for this tx',
        { companyId, runId, txId, error: err instanceof Error ? err.message : String(err) },
        'auto-post-undo',
      );
      skipped += 1;
    }
  }

  await sql`
    UPDATE bank_auto_post_runs
    SET undone_at = NOW(), undone_by = ${userId}::UUID
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Auto-post run undone', { companyId, runId, reversed, skipped, alreadyUndone }, 'auto-post-undo');
  return { reversed, skipped, alreadyUndone };
}
