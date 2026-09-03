/**
 * Budget vs Actual Export API
 * GET — export budget vs actual report as CSV
 *
 * Replicates the date-range and budget-loading logic from reports-budget-vs-actual.ts
 * so the CSV matches exactly what the UI report shows.
 *
 * Query params:
 *   period   current | ytd | full_year   (default: ytd)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

import { csvVal } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const period = (req.query.period as string) || 'ytd';

  try {
    // Resolve date range — identical logic to reports-budget-vs-actual.ts
    let startDate: string;
    let endDate: string;
    const now = new Date();

    if (period === 'current') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]!;
      endDate = now.toISOString().split('T')[0]!;
    } else {
      const fyRows = await sql`
        SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
        FROM fiscal_periods
        WHERE company_id = ${companyId} AND fiscal_year = (
          SELECT fiscal_year FROM fiscal_periods
          WHERE company_id = ${companyId} AND status = 'open'
          ORDER BY start_date DESC
          LIMIT 1
        )
      `;
      const fy = fyRows[0];
      const fyStart = fy?.start_date ? fmtDate(fy.start_date) : null;
      const fyEnd = fy?.end_date ? fmtDate(fy.end_date) : null;
      startDate = fyStart || `${now.getFullYear()}-03-01`;
      endDate = period === 'full_year'
        ? (fyEnd || `${now.getFullYear() + 1}-02-28`)
        : now.toISOString().split('T')[0]!;
    }

    // Load budget amounts — from accounting_budgets table, falling back to app_settings
    let budgets: Record<string, number> = {};
    try {
      const fiscalYear = new Date(startDate).getFullYear();
      const startMonth = new Date(startDate).getMonth(); // 0-based
      const endMonth = new Date(endDate).getMonth();
      const monthCols = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

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
          const col = monthCols[m] as string;
          total += Number(row[col] || 0);
        }
        budgets[String(row.account_code)] = total;
        budgets[String(row.gl_account_id)] = total;
      }
    } catch {
      // No accounting_budgets table — try app_settings fallback
      try {
        const [row] = await sql`SELECT value FROM app_settings WHERE key = 'accounting_budgets'`;
        if (row?.value) {
          budgets = typeof row.value === 'string' ? JSON.parse(String(row.value)) : (row.value as Record<string, number>);
        }
      } catch { /* no budgets configured */ }
    }

    // Fetch actual GL amounts for expense and revenue accounts in the period
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
          AND je.status = 'posted'
          AND je.entry_date >= ${startDate}
          AND je.entry_date <= ${endDate}
        GROUP BY jl.gl_account_id
      ) b ON b.gl_account_id = ga.id
      WHERE ga.level = 3
        AND ga.company_id = ${companyId}
        AND ga.account_type IN ('expense', 'revenue')
      ORDER BY ga.account_code
    `;

    let totalBudget = 0;
    let totalActual = 0;
    let totalVariance = 0;

    const csvLines: string[] = [
      'Account Code,Account Name,Budget,Actual,Variance,Variance %',
    ];

    for (const row of actuals) {
      const accountCode = String(row.account_code);
      const accountName = String(row.account_name);
      const budget = Number(budgets[accountCode] || budgets[String(row.id)] || 0);
      const actual = Number(row.actual_amount);
      const variance = budget - actual;
      const variancePct = budget > 0 ? (variance / budget) * 100 : 0;

      totalBudget += budget;
      totalActual += actual;
      totalVariance += variance;

      csvLines.push(
        `${csvVal(accountCode)},${csvVal(accountName)},${budget.toFixed(2)},${actual.toFixed(2)},${variance.toFixed(2)},${variancePct.toFixed(2)}`
      );
    }

    // Totals row
    const totalVariancePct = totalBudget > 0 ? (totalVariance / totalBudget) * 100 : 0;
    csvLines.push(
      `${csvVal('')},${csvVal('TOTALS')},${totalBudget.toFixed(2)},${totalActual.toFixed(2)},${totalVariance.toFixed(2)},${totalVariancePct.toFixed(2)}`
    );

    const csv = csvLines.join('\n');
    const filename = `budget-vs-actual-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to export budget vs actual report', { error: msg });
    return apiResponse.badRequest(res, 'Failed to export budget vs actual report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
