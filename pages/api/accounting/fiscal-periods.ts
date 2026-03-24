/**
 * Fiscal Periods API
 * GET  /api/accounting/fiscal-periods - List periods (optionally by year)
 * POST /api/accounting/fiscal-periods - Create fiscal year (12 monthly periods)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getFiscalPeriods,
  getCurrentFiscalPeriod,
  createFiscalYear,
} from '@/modules/accounting/services/fiscalPeriodService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const { year, current } = req.query;

      if (current === 'true') {
        const period = await getCurrentFiscalPeriod();
        return apiResponse.success(res, period);
      }

      const fiscalYear = year ? Number(year) : undefined;
      const periods = await getFiscalPeriods(fiscalYear);
      return apiResponse.success(res, periods);
    } catch (err) {
      log.error('Failed to get fiscal periods', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get fiscal periods');
    }
  }

  if (req.method === 'POST') {
    try {
      const { year } = req.body;
      if (!year || isNaN(Number(year))) {
        return apiResponse.badRequest(res, 'year is required and must be a number');
      }
      const periods = await createFiscalYear(Number(year));
      return apiResponse.success(res, periods);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create fiscal year';
      log.error('Failed to create fiscal year', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
