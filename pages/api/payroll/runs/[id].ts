/**
 * Payroll Run Detail API
 * GET /api/payroll/runs/[id]  - Get a single payroll run
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Invalid run ID');
  }

  const run = await getPayrollRun(id, companyId);
  if (!run) return apiResponse.notFound(res, 'PayrollRun', id);
  return apiResponse.success(res, run);
}

export default withAuth(withErrorHandler(handler));
