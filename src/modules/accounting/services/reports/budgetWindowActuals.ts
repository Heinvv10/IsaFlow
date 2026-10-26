/**
 * THE actuals SQL for every budget surface (budgets P0, D14). The report, its
 * CSV export, MCP budget_variance and the statement Budget column all read
 * this one query through getBudgetVariance; three drifted copies are what let
 * the export disagree with the screen (D3).
 *
 * Per revenue/expense account: posted journal-line movement in the window,
 * signed so "more is more" (revenue credit − debit, expense debit − credit).
 * The same figure the trial balance shows for the account.
 *
 *  - company_id on the lines AND the entries AND the accounts.
 *  - Posted only; the year-end close journal excluded (it zeroes the P&L).
 *  - The period filter lives INSIDE the subquery. It once sat in the ON-clause
 *    of a LEFT JOIN onto gl_journal_entries while the SUM read gl_journal_lines,
 *    so nothing was restricted and every period reported all-time totals.
 *  - No `is_active` filter: it is a picker flag, and an account deactivated
 *    mid-year still earned or spent what it did.
 *  - No `level` filter: many charts do not populate the hierarchy, and a level-2
 *    account with postings is still money (the old export dropped it).
 */

import { sql } from '@/lib/neon';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import type { RawActualRow } from './budgetVsActualLines';

export async function loadWindowActuals(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<RawActualRow[]> {
  return (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
           COALESCE(
             CASE WHEN ga.account_type = 'revenue' THEN b.credit_less_debit
                  ELSE b.debit_less_credit END
           , 0)::numeric AS actual_amount
    FROM gl_accounts ga
    LEFT JOIN (
      SELECT jl.gl_account_id,
             SUM(jl.debit - jl.credit) AS debit_less_credit,
             SUM(jl.credit - jl.debit) AS credit_less_debit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.entry_date >= ${startDate}
        AND je.entry_date <= ${endDate}
      GROUP BY jl.gl_account_id
    ) b ON b.gl_account_id = ga.id
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_type IN ('expense', 'revenue')
    ORDER BY ga.account_code
  `) as RawActualRow[];
}
