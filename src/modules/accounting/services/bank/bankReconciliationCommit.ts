/**
 * The write half of `completeReconciliation` — split out for the 300-line cap and so the TOCTOU guard sits beside
 * the UPDATE it protects. Called with the session header already locked FOR UPDATE by the caller.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { countsAsMatched } from './bankReconciliationClaim';
import { bankGlBalanceAsAt } from './bankReconciliationBalance';
import { ReconciliationNotBalancedError } from './reconciliationBalanced';
import { ReconciliationReviewRequiredError } from './reconciliationReviewGate';

/**
 * Both UPDATEs must be atomic: if the reconciliation header update fails after transactions are marked 'reconciled',
 * they become stuck in a terminal state with no completed reconciliation to reference them.
 *
 * The header UPDATE re-derives the ledger figure IN THE SAME STATEMENT and completes only when the statement
 * balance equals it to the cent. Journal posting does not take the header lock, so a back-dated journal can commit
 * between the caller's difference check and this write; completing on the checked figure would sign off a session
 * that is out by that journal. Zero rows → typed refusal (400) carrying the current difference; the transaction
 * rolls back, so the lines stay unreconciled and the session stays in progress.
 */
export async function commitReconciliation(companyId: string, id: string, userId: string): Promise<DbRow> {
  return withTransaction(async (tx) => {
    // Hein 2026-11-12 (mig 980): every line this completion reconciles must have been reviewed first. Read under
    // the header FOR UPDATE above: review and every line writer hold the session FOR SHARE, so none moves between.
    const [gate] = (await tx`
      SELECT COUNT(*)::INT AS unreviewed FROM bank_transactions bt
      JOIN bank_reconciliations br ON br.id = bt.reconciliation_id AND br.company_id = ${companyId}::UUID
      WHERE bt.reconciliation_id = ${id}::UUID AND bt.company_id = ${companyId}::UUID
        AND bt.feed_state = 'posted' AND bt.reviewed_at IS NULL
        AND ${countsAsMatched(companyId, sql`br.statement_date`)}`) as DbRow[];
    if (Number(gate?.unreviewed ?? 0) > 0) throw new ReconciliationReviewRequiredError(Number(gate!.unreviewed));
    // BL-83: company_id guard. Reconciles exactly what the session counts as
    // matched — matched lines and self-matched allocated lines.
    await tx`
      UPDATE bank_transactions bt SET status = 'reconciled', updated_at = NOW()
      FROM bank_reconciliations br
      WHERE bt.reconciliation_id = ${id}::UUID AND bt.company_id = ${companyId}::UUID
        AND br.id = bt.reconciliation_id AND br.company_id = ${companyId}::UUID
        AND bt.feed_state = 'posted'
        AND ${countsAsMatched(companyId, sql`br.statement_date`)}`;
    const rows = (await tx`
      UPDATE bank_reconciliations br
      SET status = 'completed', completed_by = ${userId}::UUID, completed_at = NOW(),
        (gl_balance, reconciled_balance) = (
          SELECT bal.gl_balance, bal.gl_balance
          FROM (${bankGlBalanceAsAt(companyId, sql`br.bank_account_id`, sql`br.statement_date`)}) bal)
      WHERE br.id = ${id}::UUID AND br.company_id = ${companyId}::UUID AND br.status = 'in_progress'
        AND br.statement_balance = (
          SELECT bal.gl_balance
          FROM (${bankGlBalanceAsAt(companyId, sql`br.bank_account_id`, sql`br.statement_date`)}) bal)
      RETURNING br.*`) as DbRow[];
    if (rows.length > 0) return rows[0]!;
    const [now] = (await tx`
      SELECT br.statement_balance - (
        SELECT bal.gl_balance
        FROM (${bankGlBalanceAsAt(companyId, sql`br.bank_account_id`, sql`br.statement_date`)}) bal) AS difference
      FROM bank_reconciliations br
      WHERE br.id = ${id}::UUID AND br.company_id = ${companyId}::UUID`) as DbRow[];
    throw new ReconciliationNotBalancedError(Number(now?.difference ?? 0));
  });
}
