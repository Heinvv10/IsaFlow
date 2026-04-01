/**
 * Project Profitability Report API
 * GET /api/accounting/reports-project-profitability
 *   ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getProjectProfitability } from '@/modules/accounting/services/financialReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { period_start, period_end } = req.query;
    if (!period_start || !period_end) {
      return apiResponse.badRequest(res, 'period_start and period_end are required');
    }

    const reports = await getProjectProfitability(companyId,
      String(period_start), String(period_end)
    );
    return apiResponse.success(res, reports);
  } catch (err) {
    log.error('Failed to get project profitability', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate project profitability');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
