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
 * THE posted bank-ledger balance as at a date: the one statement both balance fragments below are built from, so the
 * per-account figure (reconciliation, K-020) and the grouped one (the bank card, WP1) cannot drift. Posted journals
 * only, the line AND the journal in this company, entry_date on or before `asAtDate`, debit − credit. Aliases `jl` /
 * `je`; a caller adds leading columns (`select`), a join of its own rows (`join`), a further predicate (`where`) and
 * its GROUP BY.
 */
function postedBankLedgerSum(
  companyId: string,
  asAtDate: ReturnType<typeof sql>,
  parts: { select?: ReturnType<typeof sql>; join?: ReturnType<typeof sql>; where?: ReturnType<typeof sql>;
    groupBy?: ReturnType<typeof sql> },
): ReturnType<typeof sql> {
  return sql`
    SELECT ${parts.select ?? sql``} COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS gl_balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    ${parts.join ?? sql``}
    WHERE jl.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}
      ${parts.where ?? sql``}
    ${parts.groupBy ?? sql``}`;
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
  return postedBankLedgerSum(companyId, asAtDate, { where: sql`AND jl.gl_account_id = ${glAccount}` });
}

/**
 * The same balance for many (account, date) pairs in ONE pass (WP1 PR-B, the bank card): `pairs` is a query yielding
 * `account_id UUID, as_at DATE`. Answers (account_id, as_at, gl_balance) for every pair that has at least one posted
 * line on or before its date; a pair with none is absent, so callers LEFT JOIN and COALESCE to 0. Duplicate pairs
 * would double-count: pass distinct pairs. Per account, the summary called bankGlBalanceAsAt twice per account, each
 * joining the company's whole posted journal set (3.5 s at 20 accounts × 20k lines).
 */
export function bankGlBalancesAsAt(
  companyId: string,
  pairs: ReturnType<typeof sql>,
): ReturnType<typeof sql> {
  return postedBankLedgerSum(companyId, sql`q.as_at`, {
    select: sql`q.account_id, q.as_at,`,
    join: sql`JOIN (${pairs}) q ON q.account_id = jl.gl_account_id`,
    groupBy: sql`GROUP BY q.account_id, q.as_at`,
  });
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
