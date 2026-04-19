/**
 * Payroll Runs API
 * GET  /api/payroll/runs  - List payroll runs
 * POST /api/payroll/runs  - Create a new payroll run
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
import {
  listPayrollRuns,
  createPayrollRun,
} from '@/modules/accounting/services/payroll/payrollRunService';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const runs = await listPayrollRuns(companyId);
    return apiResponse.success(res, runs);
  }

  if (req.method === 'POST') {
    const { month, year } = req.body as Record<string, unknown>;
    if (!month || !year) {
      return apiResponse.badRequest(res, 'month and year are required');
    }

    const userId = (req as CompanyAuthedRequest).user?.id;
    const run = await createPayrollRun(
      companyId,
      { month: Number(month), year: Number(year) },
      userId,
    );
    return apiResponse.created(res, run);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
