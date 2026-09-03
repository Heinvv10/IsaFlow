/**
 * Year-End Service
 * Fiscal year closing: validate open periods, calculate net income,
 * create closing journal entry, lock periods.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// BL-13: gl_journal_lines now has company_id (migration 329). Queries use BOTH
// jl.company_id and je.company_id for defense-in-depth scoping.
// See docs/audits/2026-04-14/02-security-findings.md#S-002.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FiscalYearSummary {
  year_label: string;
  start_date: Date | string;
  end_date: Date | string;
  periods_open: number;
  periods_closed: number;
  status: 'open' | 'all_closed';
  total_revenue: number;
  total_expenses: number;
  net_income: number;
  /**
   * Set when the per-year revenue or expense aggregate query fails. The total
   * for the affected dimension is shown as 0 but the UI must surface a
   * warning instead of presenting it as a real "zero year". Either flag
   * means net_income is unreliable and should not be displayed without a
   * caveat.
   */
  revenue_error?: boolean;
  expense_error?: boolean;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listFiscalYears(companyId: string): Promise<FiscalYearSummary[]> {
  const years = await sql`
    SELECT
      fiscal_year                                                          AS year_label,
      MIN(start_date)                                                      AS start_date,
      MAX(end_date)                                                        AS end_date,
      COUNT(*) FILTER (WHERE status = 'open')::int                        AS periods_open,
      COUNT(*) FILTER (WHERE status IN ('closed', 'locked'))::int         AS periods_closed,
      CASE
        WHEN COUNT(*) FILTER (WHERE status = 'open') = 0
         AND COUNT(*) FILTER (WHERE status IN ('closed', 'locked')) > 0
        THEN 'all_closed'
        ELSE 'open'
      END                                                                  AS status
    FROM fiscal_periods
    WHERE company_id = ${companyId}
    GROUP BY fiscal_year
    ORDER BY MIN(start_date) DESC
  `;

  return Promise.all(
    years.map(async (fy) => {
      // Per-year aggregates are wrapped in try/catch so one slow/bad year
      // can't 500 the whole listing screen. When a query fails we set the
      // matching *_error flag so the UI can render an explicit warning
      // (rather than presenting 0 as if it were the real total).
      let totalRevenue = 0;
      let totalExpenses = 0;
      let revenueError = false;
      let expenseError = false;
      try {
        const [rev] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'revenue'
            AND je.company_id = ${companyId}
            AND jl.company_id = ${companyId}::UUID
            AND je.status     = 'posted'
            AND je.entry_date >= ${fy.start_date}
            AND je.entry_date <= ${fy.end_date}
        `;
        totalRevenue = Number(rev?.total ?? 0);
      } catch (err) {
        revenueError = true;
        log.warn('Year-end revenue aggregate failed; flagging revenue_error', { error: String(err), year: fy.year_label }, 'yearEnd');
      }
      try {
        const [exp] = await sql`
          SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'expense'
            AND je.company_id = ${companyId}
            AND jl.company_id = ${companyId}::UUID
            AND je.status     = 'posted'
            AND je.entry_date >= ${fy.start_date}
            AND je.entry_date <= ${fy.end_date}
        `;
        totalExpenses = Number(exp?.total ?? 0);
      } catch (err) {
        expenseError = true;
        log.warn('Year-end expense aggregate failed; flagging expense_error', { error: String(err), year: fy.year_label }, 'yearEnd');
      }

      const summary: FiscalYearSummary = {
        ...(fy as unknown as FiscalYearSummary),
        periods_open: Number(fy.periods_open),
        periods_closed: Number(fy.periods_closed),
        total_revenue: totalRevenue,
        total_expenses: totalExpenses,
        net_income: totalRevenue - totalExpenses,
      };
      if (revenueError) summary.revenue_error = true;
      if (expenseError) summary.expense_error = true;
      return summary;
    })
  );
}

// ─── Close year ───────────────────────────────────────────────────────────────
// Lives in yearEndCloseService: it gained a dry run (which is the half that
// matters — four year-ends in one call, then every period locked) and this file
// was close to the 300-line cap.
export {
  closeFiscalYear,
  type CloseYearResult,
  type CloseYearDryRunResult,
  type CloseYearError,
  type CloseYearOptions,
  type YearEndJournalLine,
  type YearEndJournalPreview,
} from './yearEndCloseService';
