/**
 * Dividends paid on equity accounts mapped to IS484 "Dividends paid".
 *
 * Such an account (a debit-normal "Dividends paid / declared" equity account) is mapped to an income-statement
 * line, so no balance-sheet line reads it. Its balance is a distribution out of accumulated profit, so the
 * Statement of Financial Position takes it off the derived accumulated profit, and the statement of changes in
 * equity shows the year's movement as dividends. An account of another type on IS484 is not one of these: a
 * revenue or expense account is already inside the derived profit, and an asset or liability is misplaced
 * (afsMappingSectionCheck names it). Only an ACTIVE IS484 line counts, as for every mapping the statements read.
 *
 * Amounts are raw debit-minus-credit, so a dividend paid is positive. The posted year-end close is skipped
 * (YEAR_END_JOURNAL_SOURCE), as by every AFS reader.
 */

import { sql } from '@/lib/neon';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

/** The taxonomy's "Dividends paid" line. */
export const DIVIDENDS_PAID_CODE = 'IS484';

/** Dividends paid with an entry date from `from` (inclusive; null = inception) to `through` (inclusive). */
export async function fetchDividendsPaid(companyId: string, from: string | null, through: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
    JOIN afs_account_mappings am ON am.gl_account_id = ga.id AND am.company_id = ga.company_id
    JOIN afs_statement_lines sl  ON sl.code = am.afs_line_code AND sl.company_id = am.company_id
    WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::uuid
      AND jl.company_id = ${companyId}::uuid
      AND ga.company_id = ${companyId}::uuid
      AND ga.account_type = 'equity'
      AND am.afs_line_code = ${DIVIDENDS_PAID_CODE}
      AND sl.is_active = true
      AND (${from}::date IS NULL OR je.entry_date >= ${from}::date)
      AND je.entry_date <= ${through}::date
  `) as Array<{ amount: string | number }>;
  return Number(rows[0]?.amount ?? 0);
}
