/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing. Reconciled transactions are skipped (books hygiene) — the run is
 * still marked undone, with the skip count returned.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction } from './bankAllocationService';
import { reverseJournalEntry } from '../gl/journalEntryService';

type Row = DbRow;

export interface UndoResult {
  reversed: number;
  skipped: number;
}

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

  for (const tx of txRows) {
    const txId = String(tx.id);
    if (String(tx.status) === 'reconciled') {
      skipped += 1;
      continue;
    }
    try {
      if (tx.matched_journal_line_id && tx.provisional_je_id) {
        log.warn(
          'Auto-post tx has both matched line and provisional JE — reversing matched line only',
          { companyId, runId, txId },
          'auto-post-undo',
        );
      }
      if (tx.matched_journal_line_id) {
        await reverseReconciledTransaction(companyId, txId, userId);
      } else if (tx.provisional_je_id) {
        await reverseJournalEntry(companyId, String(tx.provisional_je_id), userId);
        await sql`
          UPDATE bank_transactions
          SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
          WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
        `;
      }
      await sql`
        UPDATE bank_transactions SET auto_post_run_id = NULL
        WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
      `;
      reversed += 1;
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

  log.info('Auto-post run undone', { companyId, runId, reversed, skipped }, 'auto-post-undo');
  return { reversed, skipped };
}
