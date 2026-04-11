/**
 * Cash Flow Forecast API
 * GET ?horizon=30|60|90 — AI-powered cash flow forecast from bank transactions
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import type { CompanyApiRequest } from '@/lib/auth/withCompany';
import { log } from '@/lib/logger';
import { getForecast } from '@/modules/accounting/services/cashFlowForecastService';

const VALID_HORIZONS = new Set([30, 60, 90]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  const rawHorizon = Number(req.query['horizon'] ?? 30);
  const horizonDays = VALID_HORIZONS.has(rawHorizon) ? rawHorizon : 30;

  log.info('Cash flow forecast requested', { companyId, horizonDays }, 'cashFlowForecast');

  const forecast = await getForecast(companyId, horizonDays);

  return apiResponse.success(res, forecast);
}

export default withCompany(withErrorHandler(handler as never));
