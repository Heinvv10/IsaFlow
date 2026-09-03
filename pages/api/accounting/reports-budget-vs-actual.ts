import { sql } from '@/lib/neon';
import { localISODate, toISODate } from '@/lib/dateUtils';
/**
 * Budget vs Actual Report API
 * GET /api/accounting/reports-budget-vs-actual?period=current|ytd|full_year
 * Sage equivalent: Reports > Budget vs Actual
 *
 * Primary source: accounting_budgets table (period_amounts JSONB per fiscal year).
 * Fallback: app_settings key 'accounting_budgets', used only when no budget rows exist
 * for the current fiscal year. Both sources are filtered by company_id.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  budgetMonthKeysInWindow,
  currentMonthWindow,
  sumBudgetForWindow,
} from '@/modules/accounting/services/reports/budgetPeriodWindow';
import {
  buildBudgetVsActualLines,
  type RawActualRow,
} from '@/modules/accounting/services/reports/budgetVsActualLines';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { period = 'ytd' } = req.query;

    // Determine date range. Windows are 'YYYY-MM-DD' strings read off the LOCAL
    // calendar: `new Date(y, m, 1).toISOString()` is local midnight rendered as
    // UTC, which in SAST is 22:00 on the last day of the PREVIOUS month, so the
    // "current month" window used to open a day early and sweep in a day of the
    // previous month's actuals.
    let startDate: string;
    let endDate: string;
    // The fiscal year the budget rows are filed under. Read from fiscal_periods
    // rather than sliced off the start date: the two agree only while a fiscal
    // year starts in January (which every company here currently does), and
    // slicing would silently look up the wrong year for anyone who doesn't.
    let fiscalYear: number;
    const now = new Date();

    if (period === 'current') {
      ({ startDate, endDate } = currentMonthWindow(now));
      const [fp] = await sql`
        SELECT fiscal_year FROM fiscal_periods
        WHERE company_id = ${companyId}::UUID
          AND start_date <= ${endDate} AND end_date >= ${startDate}
        ORDER BY start_date DESC LIMIT 1
      `;
      fiscalYear = Number(fp?.fiscal_year ?? startDate.slice(0, 4));
    } else {
      // YTD or full_year — use fiscal year start
      const [fy] = await sql`
        SELECT MIN(start_date) as start_date, MAX(end_date) as end_date,
               MIN(fiscal_year) as fiscal_year
        FROM fiscal_periods
        WHERE company_id = ${companyId} AND fiscal_year = (SELECT fiscal_year FROM fiscal_periods WHERE company_id = ${companyId} AND status = 'open' ORDER BY start_date DESC LIMIT 1)
      `;
      startDate = toISODate(fy?.start_date) || `${now.getFullYear()}-01-01`;
      endDate = period === 'full_year'
        ? (toISODate(fy?.end_date) || `${now.getFullYear()}-12-31`)
        : localISODate(now);
      fiscalYear = Number(fy?.fiscal_year ?? startDate.slice(0, 4));
    }

    // Load budgets from accounting_budgets table. Months live in period_amounts
    // JSONB, keyed by calendar month name ('jan'..'dec') — see budgetService.
    //
    // The window used to be derived by comparing Date.getMonth() bounds, which
    // holds only while a fiscal year starts in January. Every company here does,
    // so that loop happened to work — but for a fiscal year starting in any
    // other month the bound goes backwards, the loop runs zero times, and the
    // report shows R0.00 of budget against real actuals, indistinguishable from
    // nobody having set a budget.
    let budgets: Record<string, number> = {};
    const monthKeys = budgetMonthKeysInWindow(startDate, endDate);

    const budgetRows = await sql`
      SELECT ab.gl_account_id, ga.account_code, ab.period_amounts, ab.annual_amount
      FROM accounting_budgets ab
      JOIN gl_accounts ga ON ga.id = ab.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE ab.company_id = ${companyId}::UUID AND ab.fiscal_year = ${fiscalYear}
    `;
    for (const row of budgetRows) {
      const total = sumBudgetForWindow(
        (row.period_amounts ?? {}) as Record<string, unknown>,
        Number(row.annual_amount ?? 0),
        monthKeys,
      );
      budgets[row.account_code] = total;
      budgets[row.gl_account_id] = total;
    }

    // If no budget rows found, try app_settings fallback
    if (Object.keys(budgets).length === 0) {
      const [settingsRow] = await sql`
        SELECT value FROM app_settings
        WHERE company_id = ${companyId} AND key = 'accounting_budgets'
        LIMIT 1
      `;
      if (settingsRow?.value) {
        budgets = typeof settingsRow.value === 'string'
          ? (JSON.parse(settingsRow.value) as Record<string, number>)
          : (settingsRow.value as Record<string, number>);
      }
    }

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
          AND je.status = 'posted'
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

    return apiResponse.success(res, { report });
  } catch (err) {
    log.error('Failed to generate budget vs actual report', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to generate budget vs actual report');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
