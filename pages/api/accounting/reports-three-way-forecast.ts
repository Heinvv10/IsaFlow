/**
 * Three-Way Forecast API
 * GET /api/accounting/reports-three-way-forecast?months=6&revenueGrowth=5&cosGrowth=3&opexGrowth=2&capex=50000
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  generateThreeWayForecast,
  type HistoricalFinancials,
  type ForecastParams,
} from '@/modules/accounting/services/threeWayForecastService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;

  const forecastMonths = Math.min(24, Math.max(1, parseInt((req.query.months as string) || '6', 10)));
  const revenueGrowthRate = parseFloat((req.query.revenueGrowth as string) || '5');
  const costOfSalesGrowthRate = parseFloat((req.query.cosGrowth as string) || '3');
  const opexGrowthRate = parseFloat((req.query.opexGrowth as string) || '2');
  const capitalExpenditure = parseFloat((req.query.capex as string) || '0');
  const taxRate = parseFloat((req.query.taxRate as string) || '27');

  const to = new Date().toISOString().split('T')[0]!;
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - 12);
  const from = fromDate.toISOString().split('T')[0]!;

  const [pnlRow, balancesRow] = await Promise.all([
    getPnLTotals(companyId, from, to),
    getBalanceSheet(companyId, to),
  ]);

  const revenue = parseFloat(pnlRow?.revenue || '0') / 12; // annualised → monthly
  const costOfSales = parseFloat(pnlRow?.cost_of_sales || '0') / 12;
  const operatingExpenses = parseFloat(pnlRow?.operating_expenses || '0') / 12;
  const netProfit = revenue - costOfSales - operatingExpenses;

  const historical: HistoricalFinancials = {
    revenue,
    costOfSales,
    operatingExpenses,
    netProfit,
    totalAssets: parseFloat(balancesRow?.total_assets || '0'),
    totalLiabilities: parseFloat(balancesRow?.total_liabilities || '0'),
    totalEquity: parseFloat(balancesRow?.total_equity || '0') + netProfit,
    currentAssets: parseFloat(balancesRow?.current_assets || '0'),
    currentLiabilities: parseFloat(balancesRow?.current_liabilities || '0'),
    cash: parseFloat(balancesRow?.cash || '0'),
    accountsReceivable: parseFloat(balancesRow?.accounts_receivable || '0'),
    accountsPayable: parseFloat(balancesRow?.accounts_payable || '0'),
    inventory: 0,
  };

  const params: ForecastParams = {
    revenueGrowthRate,
    costOfSalesGrowthRate,
    opexGrowthRate,
    capitalExpenditure,
    taxRate,
  };

  const forecast = generateThreeWayForecast(historical, params, forecastMonths);

  log.info('Three-way forecast generated', { companyId, forecastMonths, revenueGrowthRate }, 'accounting');

  return apiResponse.success(res, { forecast, historical, params });
}

async function getPnLTotals(companyId: string, from: string, to: string): Promise<Row | undefined> {
  const rows = (await sql`
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
  return rows[0];
}

async function getBalanceSheet(companyId: string, to: string): Promise<Row | undefined> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '1%' THEN jl.debit - jl.credit ELSE 0 END), 0) as total_assets,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '2%' THEN jl.credit - jl.debit ELSE 0 END), 0) as total_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '3%' THEN jl.credit - jl.debit ELSE 0 END), 0) as total_equity,
      COALESCE(SUM(CASE WHEN ga.account_code >= '1100' AND ga.account_code < '1200' THEN jl.debit - jl.credit ELSE 0 END), 0) as current_assets,
      COALESCE(SUM(CASE WHEN ga.account_code >= '2100' AND ga.account_code < '2200' THEN jl.credit - jl.debit ELSE 0 END), 0) as current_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code = '1110' THEN jl.debit - jl.credit ELSE 0 END), 0) as cash,
      COALESCE(SUM(CASE WHEN ga.account_code = '1120' THEN jl.debit - jl.credit ELSE 0 END), 0) as accounts_receivable,
      COALESCE(SUM(CASE WHEN ga.account_code = '2110' THEN jl.credit - jl.debit ELSE 0 END), 0) as accounts_payable
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date <= ${to}::date
  `) as Row[];
  return rows[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
