/**
 * Fiscal Periods API
 * GET  /api/accounting/fiscal-periods - List periods (optionally by year)
 * GET  /api/accounting/fiscal-periods?jeCounts=true&year=YYYY - Journal entry counts per period
 * POST /api/accounting/fiscal-periods - Create fiscal year (12 monthly periods)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getFiscalPeriods,
  getCurrentFiscalPeriod,
  createFiscalYear,
  getJournalCountsByYear,
} from '@/modules/accounting/services/gl/fiscalPeriodService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { year, current, jeCounts } = req.query;

      if (current === 'true') {
        const period = await getCurrentFiscalPeriod(companyId);
        return apiResponse.success(res, period);
      }

      const fiscalYear = year ? Number(year) : undefined;

      if (jeCounts === 'true' && fiscalYear) {
        const counts = await getJournalCountsByYear(companyId, fiscalYear);
        return apiResponse.success(res, counts);
      }

      const periods = await getFiscalPeriods(companyId, fiscalYear);
      return apiResponse.success(res, periods);
    } catch (err) {
      log.error('Failed to get fiscal periods', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get fiscal periods');
    }
  }

  if (req.method === 'POST') {
    try {
      const { year } = req.body as { year?: unknown };
      if (!year || isNaN(Number(year))) {
        return apiResponse.badRequest(res, 'year is required and must be a number');
      }
      const periods = await createFiscalYear(companyId, Number(year));
      return apiResponse.success(res, periods);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create fiscal year';
      log.error('Failed to create fiscal year', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
