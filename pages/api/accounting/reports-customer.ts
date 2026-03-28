/**
 * Customer Report API
 * GET /api/accounting/reports-customer?period_start=&period_end=
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getCustomerReport } from '@/modules/accounting/services/transactionReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyApiRequest;
  try {
    const { period_start, period_end } = req.query;
    if (!period_start || !period_end) return apiResponse.badRequest(res, 'period_start and period_end required');
    const report = await getCustomerReport(companyId, String(period_start), String(period_end));
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Customer report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate customer report');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
