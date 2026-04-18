/**
 * Balance Sheet Report API
 * GET /api/accounting/reports-balance-sheet
 *   ?as_at_date=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBalanceSheet } from '@/modules/accounting/services/reports/financialReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { as_at_date, cost_centre_id, compare_date } = req.query;
    if (!as_at_date) {
      return apiResponse.badRequest(res, 'as_at_date is required');
    }

    const report = await getBalanceSheet(companyId,
      String(as_at_date),
      cost_centre_id ? String(cost_centre_id) : undefined,
      compare_date ? String(compare_date) : undefined
    );
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Failed to get balance sheet', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err);
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
