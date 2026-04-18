/**
 * Supplier Report API
 * GET /api/accounting/reports-supplier?period_start=&period_end=
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getSupplierReport } from '@/modules/accounting/services/reports/transactionReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const { period_start, period_end } = req.query;
    if (!period_start || !period_end) return apiResponse.badRequest(res, 'period_start and period_end required');
    const report = await getSupplierReport(companyId, String(period_start), String(period_end));
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Supplier report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate supplier report');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
