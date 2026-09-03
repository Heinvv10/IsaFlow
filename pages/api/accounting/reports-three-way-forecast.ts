/**
 * Three-Way Forecast API
 * GET /api/accounting/reports-three-way-forecast?months=6&revenueGrowth=5&cosGrowth=3&opexGrowth=2&capex=50000
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import {
  getFinancialFigures,
  totalEquity,
  unclassifiedWarning,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { log } from '@/lib/logger';
import {
  generateThreeWayForecast,
  type HistoricalFinancials,
  type ForecastParams,
} from '@/modules/accounting/services/reports/threeWayForecastService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

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

  const figures = await getFinancialFigures(companyId, from, to);
  const { period, cumulative } = figures;

  // The window above is 12 months, so the P&L is annual — divide to monthly.
  const revenue = period.revenue / 12;
  const costOfSales = period.costOfSales / 12;
  const operatingExpenses = period.operatingExpenses / 12;
  const netProfit = revenue - costOfSales - operatingExpenses;

  const historical: HistoricalFinancials = {
    revenue,
    costOfSales,
    operatingExpenses,
    netProfit,
    totalAssets: cumulative.totalAssets,
    totalLiabilities: cumulative.totalLiabilities,
    totalEquity: totalEquity(figures),
    currentAssets: cumulative.currentAssets,
    currentLiabilities: cumulative.currentLiabilities,
    cash: cumulative.cash,
    accountsReceivable: cumulative.accountsReceivable,
    accountsPayable: cumulative.accountsPayable,
    inventory: cumulative.inventory,
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

  return apiResponse.success(res, {
    forecast,
    historical,
    params,
    unclassifiedAccounts: unclassifiedWarning(cumulative),
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
