/**
 * Project Profitability Report API
 * GET /api/accounting/reports-project-profitability
 *   ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 *   &basis=jobs|cc2 (optional; default jobs — the `projects` job; cc2 = the CC2 cost centre)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getProjectProfitability } from '@/modules/accounting/services/reports/financialReportingService';
import { isProjectBasis, PROJECT_BASES } from '@/modules/accounting/services/reports/projectBasis';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { period_start, period_end, basis } = req.query;
    if (!period_start || !period_end) {
      return apiResponse.badRequest(res, 'period_start and period_end are required');
    }
    if (basis !== undefined && !isProjectBasis(basis)) {
      return apiResponse.badRequest(res, `basis must be one of ${PROJECT_BASES.join(', ')}`);
    }

    const reports = await getProjectProfitability(companyId,
      String(period_start), String(period_end), basis ?? 'jobs'
    );
    return apiResponse.success(res, reports);
  } catch (err) {
    log.error('Failed to get project profitability', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate project profitability');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
