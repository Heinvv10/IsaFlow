/**
 * Dividends paid on dividends accounts mapped to IS484 "Dividends paid".
 *
 * A dividends account is an equity account that is debit-normal (an imported "Dividends declared") or carries the
 * subtype 'dividends' (the app creates every equity account credit-normal, so a user picks the subtype). Share
 * capital, retained earnings or a reserve on IS484 is none of these: it is misplaced, as is an asset or liability,
 * and afsMappingSectionCheck names it; a revenue or expense account is already inside the derived profit.
 *
 * Mapped to an income-statement line, a dividends account is on no balance-sheet line. Its balance is a
 * distribution out of accumulated profit, so the Statement of Financial Position takes it off the derived
 * accumulated profit, and the statement of changes in equity shows the year's movement as dividends. The line's
 * is_active is not read: a deactivated line does not take a live balance out of equity
 * (scripts/ci/check-is-active-in-balances.sh; the unmapped-value pre-export check names the account instead).
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
 * `paidOnly` leaves out a CREDIT to a dividends account whose journal also DEBITS a retained-earnings account:
 * clearing the dividends account into retained earnings, alone or inside a larger adjusting journal. That is for
 * the statement of changes in equity, where the transfer is not a distribution and must not cancel the dividends
 * paid. Every debit counts (a dividend declared in the same year-end journal), and so does a distribution
 * credited to any other account, a members' current account included. Never for the SFP, which needs the
 * account's real balance (the retained-earnings side is read on its own line). Named limit: a dividend REVERSED
 * in a journal that also debits retained earnings is read as clearing.
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
      AND ga.account_type = 'equity' AND (ga.normal_balance = 'debit' OR ga.account_subtype = 'dividends')
      AND am.afs_line_code = ${DIVIDENDS_PAID_CODE}
      AND (${from}::date IS NULL OR je.entry_date >= ${from}::date)
      AND je.entry_date <= ${through}::date
      AND (NOT ${paidOnly}::boolean OR jl.credit = 0 OR NOT EXISTS (
        SELECT 1 FROM gl_journal_lines o JOIN gl_accounts oa ON oa.id = o.gl_account_id AND oa.company_id = ${companyId}::uuid
        WHERE o.journal_entry_id = je.id AND o.company_id = ${companyId}::uuid
          AND o.debit > 0 AND oa.account_type = 'equity' AND oa.account_subtype = 'retained_earnings'))
  `) as Array<{ amount: string | number }>;
  return Number(rows[0]?.amount ?? 0);
}
