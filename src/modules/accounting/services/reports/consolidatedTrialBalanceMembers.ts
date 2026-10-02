/**
 * Per-member data gathering for the consolidated trial balance.
 *
 * Split from consolidatedTrialBalanceReport.ts to keep both files under the
 * 300-line cap. Everything here is scoped to one member company; the report
 * module owns the group-level roll-up, eliminations and the balanced assertion.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  DEFAULT_FY_START_MONTH,
  fiscalYearStart,
  getFiscalYearStartMonth,
} from '../gl/fiscalYearBasis';
import { round2 } from '../gl/trialBalanceBasis';

type Row = DbRow;

/**
 * The member's own fiscal year start for the range being reported.
 *
 * Each member is measured on ITS OWN `financial_year_start`, so its
 * income-statement figures and its brought-forward profit are cut at the same
 * date and its contribution to the group balances on its own. Members that do
 * not share a year end are reported through `coterminous`, not silently
 * averaged — IFRS 10 expects coterminous year ends (or adjustment for the gap),
 * and that is an accounting decision for the preparer, not something this
 * report should quietly make.
 *
 * READ PATH, so a tenant with no configured year start gets the March fallback
 * explicitly rather than a refusal — the group report must still render.
 */
export async function memberFiscalYearStart(companyId: string, periodStart: string): Promise<string> {
  const month = await getFiscalYearStartMonth(companyId, { fallback: DEFAULT_FY_START_MONTH });
  return fiscalYearStart(periodStart, month);
}

/**
 * Per-account balances for one member on the trial-balance basis:
 * balance-sheet accounts cumulative to `periodEnd`, income-statement accounts
 * from `fyStart` — the SAME cut the single-company report uses. This used to
 * cut the income statement at `periodStart`, so the same entity reported two
 * different revenue figures depending on which report you opened.
 */
export async function memberBalances(
  companyId: string, fyStart: string, periodEnd: string,
): Promise<Row[]> {
  return (await sql`
    SELECT ga.id AS account_id,
           COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                               OR je.entry_date >= ${fyStart}
                             THEN jl.debit ELSE 0 END), 0) AS total_debit,
           COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                               OR je.entry_date >= ${fyStart}
                             THEN jl.credit ELSE 0 END), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date <= ${periodEnd}
    GROUP BY ga.id
  `) as Row[];
}

/**
 * Profit the member earned strictly before `fyStart`, as a credit — restricted
 * to the accounts that actually reach the group chart.
 *
 * `mappedAccountIds` is not optional and not a convenience. The rows above are
 * discarded when an account has no group-CoA mapping; summing the
 * brought-forward profit over EVERY revenue and expense account then carried
 * profit from accounts whose balances had been dropped, and the group trial
 * balance went out by exactly that amount. Both sides must see the same chart.
 */
export async function memberBroughtForward(
  companyId: string, fyStart: string, mappedAccountIds: string[],
): Promise<number> {
  if (mappedAccountIds.length === 0) return 0;
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS retained
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date < ${fyStart}
      AND ga.account_type IN ('revenue', 'expense')
      AND ga.id = ANY(${mappedAccountIds}::uuid[])
  `) as Row[];
  return round2(Number(rows[0]?.retained ?? 0));
}
