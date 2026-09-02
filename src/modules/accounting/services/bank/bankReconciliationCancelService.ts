/**
 * Bank Reconciliation Cancel Service
 *
 * Cancels (deletes) an in-progress reconciliation and releases the bank
 * transactions it claimed. Completed reconciliations are never cancellable —
 * their transactions are in the terminal 'reconciled' state.
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface CancelReconciliationOptions {
  /**
   * Run every guard and report what WOULD be released, writing nothing. The
   * guards are the same ones the live path runs — only the writes are skipped —
   * so a dry run that succeeds is a real answer about the current state.
   */
  dryRun?: boolean;
}

export interface CancelReconciliationResult {
  /** Transactions whose 'matched' link was undone and returned to 'imported'. */
  revertedMatches: number;
  /** Transactions detached from the reconciliation (includes the reverted ones). */
  releasedTransactions: number;
}

/**
 * Thrown when the reconciliation cannot be cancelled as it stands. The message
 * is caller-facing: routes surface it verbatim as a 400.
 */
export class ReconciliationNotCancellableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationNotCancellableError';
  }
}

export async function cancelReconciliation(
  companyId: string, id: string, userId: string,
  opts: CancelReconciliationOptions = {}
): Promise<CancelReconciliationResult> {
  const reconRows = (await sql`
    SELECT id, status FROM bank_reconciliations
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (reconRows.length === 0) {
    throw new ReconciliationNotCancellableError(`Reconciliation ${id} not found`);
  }
  if (String(reconRows[0]!.status) !== 'in_progress') {
    throw new ReconciliationNotCancellableError(
      'Only an in-progress reconciliation can be cancelled',
    );
  }

  // Adjustment journals post to the GL and name this reconciliation as the
  // record behind them (source_record_id — migration 526). Deleting the
  // reconciliation under them would leave posted journals pointing at nothing,
  // so refuse until they are reversed. Reversed ones no longer count.
  const adjRows = (await sql`
    SELECT COUNT(*) AS cnt FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND source = 'auto_bank_recon'
      AND source_record_id = ${id}::UUID
      AND status = 'posted'`) as DbRow[];
  const adjustments = Number(adjRows[0]!.cnt);
  if (adjustments > 0) {
    throw new ReconciliationNotCancellableError(
      `Cannot cancel: ${adjustments} posted adjustment journal${adjustments === 1 ? '' : 's'} `
      + 'reference this reconciliation — reverse them first',
    );
  }

  // 'reconciled' is only reachable through completion. Finding one under an
  // in-progress header means the data is inconsistent; releasing it would strand
  // a transaction in a terminal state with no reconciliation behind it.
  const reconciledRows = (await sql`
    SELECT COUNT(*) AS cnt FROM bank_transactions
    WHERE reconciliation_id = ${id}::UUID AND company_id = ${companyId}::UUID
      AND status = 'reconciled'`) as DbRow[];
  if (Number(reconciledRows[0]!.cnt) > 0) {
    throw new ReconciliationNotCancellableError(
      'Cannot cancel: this reconciliation already has reconciled transactions',
    );
  }

  if (opts.dryRun) {
    const projected = (await sql`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'matched') AS matched
      FROM bank_transactions
      WHERE reconciliation_id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    return {
      revertedMatches: Number(projected[0]!.matched),
      releasedTransactions: Number(projected[0]!.total),
    };
  }

  // One transaction: a failure between the release and the DELETE would either
  // orphan transactions on a deleted header or leave a header whose rows have
  // already been released.
  const result = await withTransaction(async (tx) => {
    // Matching is reconciliation work and is undone with the session. Allocated,
    // provisional and excluded rows keep their status and their journal link —
    // those exist independently of this reconciliation — and are only detached.
    const reverted = (await tx`
      UPDATE bank_transactions
      SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL,
          updated_at = NOW()
      WHERE reconciliation_id = ${id}::UUID AND company_id = ${companyId}::UUID
        AND status = 'matched'
      RETURNING id`) as DbRow[];
    const detached = (await tx`
      UPDATE bank_transactions
      SET reconciliation_id = NULL, updated_at = NOW()
      WHERE reconciliation_id = ${id}::UUID AND company_id = ${companyId}::UUID
      RETURNING id`) as DbRow[];
    // Re-assert the status in the DELETE: a concurrent complete would have moved
    // it on after the read above, and must not be silently discarded.
    const deleted = (await tx`
      DELETE FROM bank_reconciliations
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'in_progress'
      RETURNING id`) as DbRow[];
    if (deleted.length === 0) {
      throw new ReconciliationNotCancellableError(
        'Reconciliation changed while cancelling — reload and try again',
      );
    }
    return {
      revertedMatches: reverted.length,
      releasedTransactions: reverted.length + detached.length,
    };
  });

  log.info('Cancelled bank reconciliation', {
    id, userId, revertedMatches: result.revertedMatches,
    releasedTransactions: result.releasedTransactions,
  }, 'accounting');
  return result;
}
