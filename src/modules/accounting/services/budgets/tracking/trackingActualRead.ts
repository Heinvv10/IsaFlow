/**
 * THE actuals SQL of the budgets programme (contract ownership: P3 owns it;
 * P4/P5/P6 read actuals only through it). Posted journal-line movement per
 * revenue/expense account and calendar month, optionally per dimension
 * member, under a dimension filter.
 *
 * The predicates are `incomeStatementService.fetchIncomeStatementRows`':
 *   - company_id on the lines, the entries and the accounts;
 *   - posted only; the year-end close journal left out (it zeroes the P&L);
 *   - revenue and expense accounts only;
 *   - `entry_date` inside [start, end], both ends inclusive.
 * Natural sign: revenue credit − debit, expense debit − credit.
 *
 * Filters are EXPLICIT levels, ANDed: `jl.cc1_id = cc1`, `jl.cc2_id = cc2`,
 * `jl.bu_id = bu`; an untagged line falls outside any filter that names that
 * level. `costCentre` is the statement pages' either-level meaning
 * (`cc1_id = X OR cc2_id = X`), for the comparator (PR-C). The month is read as
 * text by Postgres (`to_char`), so no Date is built to find it.
 *
 * Window, band and projection actuals are sums of these months, which is what
 * invariant 1 (tests/integration/budget-tracking-is-invariant.int.test.ts)
 * holds against the income statement.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import type { AccountMeta } from './trackingLines';
import type { TrackingFilter, TrackingGroupBy } from './trackingTypes';

export interface ActualRow extends AccountMeta {
  /** 'YYYY-MM'. */
  month: string;
  /** The `groupBy` member on the line (null: untagged at that level); always null without `groupBy`. */
  memberId: string | null;
  amount: number;
}

export async function readTrackingActuals(
  companyId: string,
  startDate: string,
  endDate: string,
  filter: TrackingFilter = {},
  groupBy: TrackingGroupBy | null = null,
): Promise<ActualRow[]> {
  if (endDate < startDate) return [];
  const cc1 = filter.cc1 ?? null;
  const cc2 = filter.cc2 ?? null;
  const bu = filter.bu ?? null;
  const cc = filter.costCentre ?? null;
  // The member column is a CASE over a bound value, never an interpolated identifier.
  const rows = (await sql`
    SELECT ga.id::TEXT AS account_id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype,
           to_char(je.entry_date, 'YYYY-MM') AS month,
           (CASE ${groupBy}::TEXT WHEN 'cc1' THEN jl.cc1_id WHEN 'cc2' THEN jl.cc2_id WHEN 'bu' THEN jl.bu_id END)::TEXT AS member_id,
           SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END)::TEXT AS amount
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
     WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
       AND je.company_id = ${companyId}::UUID
       AND jl.company_id = ${companyId}::UUID
       AND je.entry_date >= ${startDate}::DATE
       AND je.entry_date <= ${endDate}::DATE
       AND ga.account_type IN ('revenue', 'expense')
       AND (${cc1}::TEXT IS NULL OR jl.cc1_id = ${cc1}::UUID)
       AND (${cc2}::TEXT IS NULL OR jl.cc2_id = ${cc2}::UUID)
       AND (${bu}::TEXT IS NULL OR jl.bu_id = ${bu}::UUID)
       AND (${cc}::TEXT IS NULL OR jl.cc1_id = ${cc}::UUID OR jl.cc2_id = ${cc}::UUID)
     GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype, 6, 7
     ORDER BY ga.account_code, 6
  `) as DbRow[];
  return rows.map((r) => ({
    accountId: String(r.account_id).toLowerCase(),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type) === 'revenue' ? 'revenue' : 'expense',
    accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
    month: String(r.month),
    memberId: r.member_id == null ? null : String(r.member_id).toLowerCase(),
    amount: Number(r.amount),
  }));
}

/** The latest posted entry date in [start, end] ('YYYY-MM-DD'), or null when nothing posted. */
export async function readPostedThrough(companyId: string, startDate: string, endDate: string): Promise<string | null> {
  if (endDate < startDate) return null;
  const rows = (await sql`
    SELECT MAX(je.entry_date)::TEXT AS posted_through
      FROM gl_journal_entries je
     WHERE je.company_id = ${companyId}::UUID
       AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
       AND je.entry_date >= ${startDate}::DATE
       AND je.entry_date <= ${endDate}::DATE
  `) as DbRow[];
  const raw = rows[0]?.posted_through;
  return raw == null ? null : String(raw);
}
