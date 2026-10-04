/**
 * The stored GL figure of a reconciliation session — split out of `bankReconciliationService` (which re-exports
 * `updateReconciledBalance`) for the 300-line cap when D12 round 2 added the adjustment's non-waiting refresh.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isLockNotAvailable } from './bankTxLock';

export async function updateReconciledBalance(companyId: string, reconciliationId: string): Promise<void> {
  // Single atomic UPDATE — avoids race condition from read-then-write pattern.
  // Both the outer UPDATE and inner SELECT are scoped by company_id to prevent
  // cross-tenant contamination if two tenants share a reconciliation_id UUID.
  // K-020: recompute the bank GL balance live as at statement_date rather than
  // adding matched bank amounts to the frozen gl_balance snapshot. Matching only
  // stamps a bank row against an already-posted line, so that movement is already
  // inside the GL balance and adding it counted it twice; the adjustment journal
  // this helper is called to reflect never entered the frozen column at all.
  await sql`
    UPDATE bank_reconciliations br
    SET (gl_balance, reconciled_balance) = (
      SELECT bal.gl_balance, bal.gl_balance
      FROM (${bankGlBalanceAsAt(
        companyId, sql`br.bank_account_id`, sql`br.statement_date`)}) bal
    )
    WHERE br.id = ${reconciliationId}::UUID
      AND br.company_id = ${companyId}::UUID
      AND br.status = 'in_progress' -- a completed one is an audit artefact
  `;
}

/**
 * Posted bank-account GL balance as at a date, as a composable fragment.
 * Both the startReconciliation snapshot and the updateReconciledBalance
 * recompute build on this one definition so the two cannot drift — drift
 * between a frozen snapshot and a later figure was defect K-020. The account
 * and date arrive as fragments because the recompute correlates on the
 * reconciliation row's own columns while the snapshot binds parameters.
 */
export function bankGlBalanceAsAt(
  companyId: string,
  glAccount: ReturnType<typeof sql>,
  asAtDate: ReturnType<typeof sql>,
): ReturnType<typeof sql> {
  return sql`
    SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS gl_balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.gl_account_id = ${glAccount}
      AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}`;
}

/**
 * D12 round 2 (brk-d12 B1): the adjustment's header refresh, WITHOUT waiting on other sharers of the session. The
 * adjustment holds the session FOR SHARE only (it posts a journal); refreshing needs the row, and waiting for it while
 * a line writer that shares the session waits on our journal number would be the 40P01 the shared lock exists to
 * avoid. So: NOWAIT, in its own savepoint; held -> the refresh is skipped and logged — the journal stands, and
 * completion recomputes the figure under its own lock before it signs off.
 */
export async function refreshReconciledBalanceIfFree(companyId: string, reconciliationId: string): Promise<boolean> {
  try {
    await withSavepoint('recon_adjust_refresh', async () => {
      await sql`
        SELECT id FROM bank_reconciliations
        WHERE id = ${reconciliationId}::UUID AND company_id = ${companyId}::UUID
        FOR NO KEY UPDATE NOWAIT`;
      await updateReconciledBalance(companyId, reconciliationId);
    });
    return true;
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    log.info('Adjustment posted; header refresh skipped — another request shares the session (completion recomputes)',
      { reconciliationId }, 'accounting');
    return false;
  }
}
