/**
 * Ratio Trends API
 * GET /api/accounting/reports-ratio-trends?months=6
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import {
  getFinancialFigures,
  toFinancialData,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateRatioTrends } from '@/modules/accounting/services/reports/ratioTrendService';
import type { FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
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

async function buildMonthData(companyId: string, from: string, to: string): Promise<FinancialData> {
  const figures = await getFinancialFigures(companyId, from, to);
  return {
    ...toFinancialData(figures),
    // Ratio trends divide by equity; guard the zero-equity chart of accounts.
    totalEquity: Math.max(
      1,
      figures.cumulative.totalEquity + figures.period.netProfit
    ),
  };
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
