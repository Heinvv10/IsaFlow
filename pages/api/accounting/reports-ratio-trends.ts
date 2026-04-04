/**
 * Ratio Trends API
 * GET /api/accounting/reports-ratio-trends?months=6
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { calculateRatioTrends } from '@/modules/accounting/services/ratioTrendService';
import type { FinancialData } from '@/modules/accounting/services/reportingEngineService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const months = Math.min(12, Math.max(3, parseInt(String(req.query.months || '6'), 10)));

  // Build financial data for each of the last N months
  const now = new Date();
  const periodsData: FinancialData[] = [];
  const periodLabels: string[] = [];

  const monthSlots = Array.from({ length: months }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    const from = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const to = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    const label = date.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
    return { from, to, label };
  });

  const results = await Promise.all(
    monthSlots.map(({ from, to }) => buildMonthData(companyId, from, to))
  );

  for (let i = 0; i < monthSlots.length; i++) {
    periodsData.push(results[i] as FinancialData);
    periodLabels.push(monthSlots[i]!.label);
  }

  const trends = calculateRatioTrends(periodsData, periodLabels);

  return apiResponse.success(res, { months, trends });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function buildMonthData(companyId: string, from: string, to: string): Promise<FinancialData> {
  const [totals] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as operating_expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
  `) as Row[];

  const [bal] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '1%' THEN jl.debit - jl.credit ELSE 0 END), 0) as total_assets,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '2%' THEN jl.credit - jl.debit ELSE 0 END), 0) as total_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code >= '1100' AND ga.account_code < '1200' THEN jl.debit - jl.credit ELSE 0 END), 0) as current_assets,
      COALESCE(SUM(CASE WHEN ga.account_code >= '2100' AND ga.account_code < '2200' THEN jl.credit - jl.debit ELSE 0 END), 0) as current_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code = '1110' THEN jl.debit - jl.credit ELSE 0 END), 0) as cash,
      COALESCE(SUM(CASE WHEN ga.account_code = '1120' THEN jl.debit - jl.credit ELSE 0 END), 0) as ar,
      COALESCE(SUM(CASE WHEN ga.account_code = '2110' THEN jl.credit - jl.debit ELSE 0 END), 0) as ap
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted' AND je.entry_date <= ${to}::date
  `) as Row[];

  const revenue = parseFloat(totals?.revenue || '0');
  const cos = parseFloat(totals?.cost_of_sales || '0');
  const opex = parseFloat(totals?.operating_expenses || '0');

  return {
    revenue, costOfSales: cos, operatingExpenses: opex,
    netProfit: revenue - cos - opex,
    totalAssets: parseFloat(bal?.total_assets || '0'),
    totalLiabilities: parseFloat(bal?.total_liabilities || '0'),
    totalEquity: Math.max(1, parseFloat(bal?.total_assets || '0') - parseFloat(bal?.total_liabilities || '0')),
    currentAssets: parseFloat(bal?.current_assets || '0'),
    currentLiabilities: parseFloat(bal?.current_liabilities || '0'),
    inventory: 0,
    accountsReceivable: parseFloat(bal?.ar || '0'),
    accountsPayable: parseFloat(bal?.ap || '0'),
    cash: parseFloat(bal?.cash || '0'),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
