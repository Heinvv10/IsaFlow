/**
 * KPI Dashboard API
 * GET /api/accounting/kpi-dashboard
 *   ?from=YYYY-MM-DD   - period start (defaults to start of current month)
 *   ?to=YYYY-MM-DD     - period end (defaults to today)
 *   ?months=N           - chart lookback months (default 6)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getDashboardKPIs,
  getRevenueChart,
  getCashFlowChart,
  getAgingBreakdown,
  getTopCustomers,
  getTopExpenseCategories,
} from '@/modules/accounting/services/kpiService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const from = req.query.from
      ? String(req.query.from)
      : `${year}-${String(month).padStart(2, '0')}-01`;
    const to = req.query.to
      ? String(req.query.to)
      : now.toISOString().slice(0, 10);
    const months = req.query.months ? Number(req.query.months) : 6;

    const [kpis, revenueChart, cashFlowChart, arAging, apAging, topCustomers, topExpenses] =
      await Promise.all([
        getDashboardKPIs(companyId, from, to),
        getRevenueChart(companyId, months),
        getCashFlowChart(companyId, months),
        getAgingBreakdown(companyId, 'ar'),
        getAgingBreakdown(companyId, 'ap'),
        getTopCustomers(companyId, 5),
        getTopExpenseCategories(companyId, 5),
      ]);

    return apiResponse.success(res, {
      kpis,
      revenueChart,
      cashFlowChart,
      arAging,
      apAging,
      topCustomers,
      topExpenses,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load KPI dashboard';
    log.error('Failed to load KPI dashboard', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
