/**
 * Balances a take-on carried into equity during a period, by AFS line: the
 * AFS SOCE's "Balances taken on" column (equity.ts), so a take-on is not
 * hidden inside Movement. A take-on journal is gl/takeOnJournalSource's; the
 * report SOCE (changesInEquityService) reads the same postings as its takeOn
 * row, and the income statement's IS484 leaves them out (_helpers).
 *
 * Credit-positive like the SOCE's other columns. Equity accounts only. A
 * dividends account on IS484 (the same test as dividendsPaid.fetchDividendsPaid:
 * debit-normal, or subtype 'dividends') is reported under the IS484 code; the
 * SOCE puts it on the accumulated-profit row, where its balance is carried.
 */
import { sql } from '@/lib/neon';
import { TAKE_ON_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/takeOnJournalSource';
import { DIVIDENDS_PAID_CODE } from './dividendsPaid';

export async function fetchTakeOnByLine(companyId: string, from: string, through: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT am.afs_line_code AS code, COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}::uuid
    JOIN gl_accounts ga        ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::uuid
    JOIN afs_account_mappings am ON am.gl_account_id = ga.id AND am.company_id = ${companyId}::uuid
    WHERE jl.company_id = ${companyId}::uuid
      AND je.status = 'posted' AND je.source = ${TAKE_ON_JOURNAL_SOURCE}
      AND je.entry_date BETWEEN ${from}::date AND ${through}::date
      AND ga.account_type = 'equity'
      AND (am.afs_line_code <> ${DIVIDENDS_PAID_CODE} OR ga.normal_balance = 'debit' OR ga.account_subtype = 'dividends')
    GROUP BY am.afs_line_code
  `) as Array<{ code: string; amount: string | number }>;
  return new Map(rows.map((r) => [String(r.code), Number(r.amount)]));
}
