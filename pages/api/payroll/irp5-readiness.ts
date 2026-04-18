/**
 * IRP5 Readiness API
 * GET /api/payroll/irp5-readiness?taxYear=2026
 * Returns per-employee blocking issues + warnings + company roll-up.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { computeCompanyReadiness } from '@/modules/payroll/payrollReadinessService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) {
    return apiResponse.badRequest(res, 'Invalid taxYear');
  }

  try {
    const data = await computeCompanyReadiness(req.companyId, taxYear);
    return apiResponse.success(res, data);
  } catch (err) {
    log.error('irp5-readiness GET failed', { error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to compute IRP5 readiness');
  }
}

export default withAuth(withErrorHandler(handler));
