import { sql } from '@/lib/neon';
import { toISODate } from '@/lib/dateUtils';
/**
 * Budget vs Actual Report API
 * GET /api/accounting/reports-budget-vs-actual?period=current|ytd|full_year
 * Sage equivalent: Reports > Budget vs Actual
 *
 * Reads budgets from gl_accounts.budget_amount column (if exists)
 * or from app_settings key 'accounting_budgets'.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
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

    // Determine date range
    let startDate: string;
    let endDate: string;
    const now = new Date();

    if (period === 'current') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0] ?? '';
      endDate = now.toISOString().split('T')[0] ?? '';
    } else {
      // YTD or full_year — use fiscal year start
      const [fy] = await sql`
        SELECT MIN(start_date) as start_date, MAX(end_date) as end_date
        FROM fiscal_periods
        WHERE company_id = ${companyId} AND fiscal_year = (SELECT fiscal_year FROM fiscal_periods WHERE company_id = ${companyId} AND status = 'open' ORDER BY start_date DESC LIMIT 1)
      `;
      startDate = toISODate(fy?.start_date) || `${now.getFullYear()}-03-01`;
      endDate = period === 'full_year'
        ? (toISODate(fy?.end_date) || `${now.getFullYear() + 1}-02-28`)
        : (now.toISOString().split('T')[0] ?? '');
    }

    // Load budgets from accounting_budgets table
    // Determine which month columns to sum based on period
    let budgets: Record<string, number> = {};
    try {
      const fiscalYear = new Date(startDate).getFullYear();
      const startMonth = new Date(startDate).getMonth(); // 0-based
      const endMonth = new Date(endDate).getMonth();
      const monthCols = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

      const budgetRows = await sql`
        SELECT ab.gl_account_id, ga.account_code,
          ab.jan, ab.feb, ab.mar, ab.apr, ab.may, ab.jun,
          ab.jul, ab.aug, ab.sep, ab.oct, ab.nov, ab.dec
        FROM accounting_budgets ab
        JOIN gl_accounts ga ON ga.id = ab.gl_account_id
        WHERE ab.company_id = ${companyId} AND ab.fiscal_year = ${fiscalYear}
      `;
      for (const row of budgetRows) {
        let total = 0;
        for (let m = startMonth; m <= endMonth; m++) {
          total += Number(row[monthCols[m] ?? ''] ?? 0);
        }
        budgets[row.account_code] = total;
        budgets[row.gl_account_id] = total;
      }
    } catch {
      // No budgets configured yet — fall back to app_settings
      try {
        const [row] = await sql`SELECT value FROM app_settings WHERE key = 'accounting_budgets'`;
        if (row?.value) {
          budgets = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        }
      } catch { /* no budgets */ }
    }

    // Get actual GL balances for expense and revenue accounts. We don't filter
    // by ga.level — many companies don't populate the hierarchy fully and that
    // filter previously returned an empty list. Accounts with no budget AND no
    // actual movement are dropped from the response (see filter below) so that
    // header rows don't pollute the report with empty entries.
    const actuals = await sql`
      SELECT
        ga.id, ga.account_code, ga.account_name, ga.account_type,
        COALESCE(SUM(
          CASE
            WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit
            WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
            ELSE jl.debit - jl.credit
          END
        ), 0)::numeric as actual_amount
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
        AND je.entry_date >= ${startDate}
        AND je.entry_date <= ${endDate}
      WHERE ga.is_active = true
        AND ga.company_id = ${companyId}
        AND ga.account_type IN ('expense', 'revenue')
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type
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
