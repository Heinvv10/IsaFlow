/**
 * Payroll Run Detail API
 * GET /api/payroll/payroll-runs-detail?id=xxx  - Get run with payslips
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getPayrollRun } from '@/modules/payroll/payrollService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Payroll run ID is required');
  }

  try {
    const run = await getPayrollRun(companyId, id);
    if (!run) {
      return apiResponse.notFound(res, 'Payroll run', id);
    }
    return apiResponse.success(res, run);
  } catch (err) {
    log.error('payroll run detail GET failed', { id, error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to fetch payroll run');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
