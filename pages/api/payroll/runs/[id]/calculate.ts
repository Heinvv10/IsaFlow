/**
 * Payroll Run Calculate API
 * POST /api/payroll/runs/[id]/calculate  - Run payroll calculation for a run
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Invalid run ID');
  }

  try {
    const summary = await calculatePayrollRun(id, companyId);
    return apiResponse.success(res, summary);
  } catch (err) {
    if (err instanceof PayrollRunLockedError) {
      return apiResponse.badRequest(res, err.message, { lockedStatus: err.status });
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
