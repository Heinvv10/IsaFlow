/**
 * Cash Flow Forecast API
 * GET ?months=3|6|12 — deterministic monthly forecast for the dashboard chart.
 * GET ?horizon=30|60|90 — AI-powered weekly forecast (legacy callers).
 *
 * The page at /accounting/cash-flow-forecast uses the monthly variant. The AI
 * weekly variant is kept for back-compat with any older callers.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { log } from '@/lib/logger';
import {
  getForecast,
  generateForecast,
  getHistoricalForChart,
} from '@/modules/accounting/services/reports/cashFlowForecastService';

const VALID_HORIZONS = new Set([30, 60, 90]);
const VALID_MONTHS = new Set([3, 6, 12]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  // Monthly mode: page at /accounting/cash-flow-forecast
  if (req.query['months'] !== undefined) {
    const rawMonths = Number(req.query['months']);
    const months = VALID_MONTHS.has(rawMonths) ? rawMonths : 6;

    log.info('Cash flow forecast (monthly) requested', { companyId, months }, 'cashFlowForecast');

    try {
      const [forecast, historical] = await Promise.all([
        generateForecast(companyId, months),
        getHistoricalForChart(companyId, months),
      ]);
      return apiResponse.success(res, { ...forecast, historical });
    } catch (err) {
      log.error('Cash flow monthly forecast failed', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to generate cash flow forecast');
    }
  }

  // Weekly AI mode (legacy)
  const rawHorizon = Number(req.query['horizon'] ?? 30);
  const horizonDays = VALID_HORIZONS.has(rawHorizon) ? rawHorizon : 30;

  log.info('Cash flow forecast (AI) requested', { companyId, horizonDays }, 'cashFlowForecast');

  try {
    const forecast = await getForecast(companyId, horizonDays);
    return apiResponse.success(res, forecast);
  } catch (err) {
    log.error('Cash flow AI forecast failed', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to generate cash flow forecast');
  }
}

export default withAuth(withErrorHandler(handler as never));
