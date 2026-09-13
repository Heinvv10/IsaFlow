/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing. Reconciled transactions are skipped (books hygiene) — the run is
 * still marked undone, with the skip count returned.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction, reverseProvisionalEntry } from './bankAllocationService';

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
      // Provisional FIRST. A controlled provisional posting deliberately carries
      // BOTH the bank journal line and the provisional link — the line is what
      // its reversal proves the original allocation by — so the old "both set"
      // warning now describes the designed shape, and taking the matched-line
      // branch for such a row would miss the one that predates the controls (no
      // intent to reverse against). reverseProvisionalEntry picks the right
      // provenance for either.
      if (tx.provisional_je_id) {
        // The controlled reversal of the owning allocation — a direct
        // reverseJournalEntry was refused for a generated journal and poisoned
        // the request, so no run holding a provisional entry could be undone. It
        // returns the bank transaction to the queue itself.
        await reverseProvisionalEntry(companyId, String(tx.provisional_je_id), userId, { reason: 'Auto-post run undone' });
      } else if (tx.matched_journal_line_id) {
        await reverseReconciledTransaction(companyId, txId, userId);
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
