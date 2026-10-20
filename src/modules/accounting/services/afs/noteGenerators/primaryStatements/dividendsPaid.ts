/**
 * Dividends paid on DEBIT-NORMAL equity accounts mapped to IS484 "Dividends paid".
 *
 * Such an account (a "Dividends paid / declared" equity account) is mapped to an income-statement line, so no
 * balance-sheet line reads it. Its balance is a distribution out of accumulated profit, so the
 * Statement of Financial Position takes it off the derived accumulated profit, and the statement of changes in
 * equity shows the year's movement as dividends. Only a debit-normal equity account is one: share capital, retained
 * earnings or a reserve on IS484 (credit-normal) is misplaced, as is an asset or liability, and afsMappingSectionCheck
 * names it; a revenue or expense account is already inside the derived profit. The line's is_active is not read: a deactivated line does not take a live
 * balance out of equity (scripts/ci/check-is-active-in-balances.sh).
 *
 * Amounts are raw debit-minus-credit, so a dividend paid is positive. The posted year-end close is skipped
 * (YEAR_END_JOURNAL_SOURCE), as by every AFS reader.
 */

import { sql } from '@/lib/neon';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

/** The taxonomy's "Dividends paid" line. */
export const DIVIDENDS_PAID_CODE = 'IS484';

/**
 * Dividends paid with an entry date from `from` (inclusive; null = inception) to `through` (inclusive).
 *
 * `paidOnly` leaves out journals that touch equity accounts alone (clearing the dividends account into retained
 * earnings, say): for the statement of changes in equity, where such a transfer is not a distribution and must not
 * cancel the dividends paid. Never for the SFP, which needs the account's real balance (the retained-earnings side
 * of the transfer is read on its own balance-sheet line).
 */
export async function fetchDividendsPaid(
  companyId: string, from: string | null, through: string, paidOnly = false,
): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
    JOIN afs_account_mappings am ON am.gl_account_id = ga.id AND am.company_id = ga.company_id
    WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::uuid
      AND jl.company_id = ${companyId}::uuid
      AND ga.company_id = ${companyId}::uuid
      AND ga.account_type = 'equity' AND ga.normal_balance = 'debit'
      AND am.afs_line_code = ${DIVIDENDS_PAID_CODE}
      AND (${from}::date IS NULL OR je.entry_date >= ${from}::date)
      AND je.entry_date <= ${through}::date
      AND (NOT ${paidOnly}::boolean OR EXISTS (
        SELECT 1 FROM gl_journal_lines o JOIN gl_accounts oa ON oa.id = o.gl_account_id AND oa.company_id = ${companyId}::uuid
        WHERE o.journal_entry_id = je.id AND o.company_id = ${companyId}::uuid AND oa.account_type <> 'equity'))
  `) as Array<{ amount: string | number }>;
  return Number(rows[0]?.amount ?? 0);
}
