import { sql } from '@/lib/neon';
/**
 * Budget vs Actual Report API
 * GET /api/accounting/reports-budget-vs-actual?period=current|ytd|full_year[&fiscal_year=2027]
 * `fiscal_year` (optional, ytd and full_year only) is a financial-year label from the
 * registry: 404 when no year carries it, 400 when it is not a label.
 * Sage equivalent: Reports > Budget vs Actual
 *
 * Budgets come from budget_month_amounts (one amount per account per calendar
 * month): the window's budget is the sum of the months inside it. The window
 * itself comes from the fiscal-year registry (see budgetWindowService).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { loadWindowBudgets, resolveBudgetWindow } from '@/modules/accounting/services/reports/budgetWindowService';
import { BudgetReportYearError, chosenReportYear, reportYearOptions } from '@/modules/accounting/services/reports/budgetReportYear';
import { localISODate } from '@/lib/dateUtils';
import {
  buildBudgetVsActualLines,
  type RawActualRow,
} from '@/modules/accounting/services/reports/budgetVsActualLines';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    // Windows are 'YYYY-MM-DD' strings read off the LOCAL calendar and the
    // fiscal-year registry: `new Date(y, m, 1).toISOString()` is local midnight
    // rendered as UTC, which in SAST is 22:00 on the last day of the PREVIOUS
    // month, so "current month" used to open a day early.
    const period = String(req.query.period ?? 'ytd');
    const chosen = await chosenReportYear(companyId, req.query.fiscal_year, period);
    const { startDate, endDate, fiscalYear } = await resolveBudgetWindow(companyId, period, new Date(), chosen);
    const budgets = await loadWindowBudgets(companyId, startDate, endDate);

    // Get actual GL balances for expense and revenue accounts. We don't filter
    // by ga.level — many companies don't populate the hierarchy fully and that
    // filter previously returned an empty list. Accounts with no budget AND no
    // actual movement are dropped from the response (see filter below) so that
    // header rows don't pollute the report with empty entries.
    // The period filter MUST live inside this subquery. It used to sit in the
    // ON-clause of a LEFT JOIN onto gl_journal_entries while the SUM read
    // gl_journal_lines, so neither the date range nor the posted check
    // restricted anything: a line whose entry fell outside the period simply
    // got NULL entry columns and was still summed. Every period therefore
    // reported all-time totals -- Brightsphere September 2026 showed
    // R18,728,651.55 of actuals against a true R0.00.
    //
    // is_active is deliberately absent: it is a picker flag, and an account
    // deactivated mid-year still earned or spent what it earned or spent.
    const actuals = await sql`
      SELECT
        ga.id, ga.account_code, ga.account_name, ga.account_type,
        COALESCE(
          CASE
            WHEN ga.account_type = 'revenue' THEN b.credit_less_debit
            ELSE b.debit_less_credit
          END
        , 0)::numeric as actual_amount
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
      WHERE ga.company_id = ${companyId}
        AND ga.account_type IN ('expense', 'revenue')
      ORDER BY ga.account_code
    `;

    const lines = buildBudgetVsActualLines(actuals as unknown as RawActualRow[], budgets);

    const report = {
      period: `${startDate} to ${endDate}`,
      lines,
      total_budget: lines.reduce((s, l) => s + l.budget_amount, 0),
      total_actual: lines.reduce((s, l) => s + l.actual_amount, 0),
      total_variance: lines.reduce((s, l) => s + l.variance, 0),
    };

    return apiResponse.success(res, {
      report, fiscal_year: fiscalYear.fiscalYear, years: await reportYearOptions(companyId, localISODate()),
    });
  } catch (err) {
    if (err instanceof BudgetReportYearError) {
      return err.unknown ? apiResponse.notFound(res, 'Financial year', String(err.label)) : apiResponse.badRequest(res, err.message);
    }
    log.error('Failed to generate budget vs actual report', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to generate budget vs actual report');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
