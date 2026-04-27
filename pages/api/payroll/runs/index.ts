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
  PayrollRunDuplicateError,
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
    const monthNum = Number(month);
    const yearNum = Number(year);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return apiResponse.badRequest(res, 'month must be an integer between 1 and 12');
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return apiResponse.badRequest(res, 'year must be a 4-digit fiscal year');
    }

    const userId = (req as CompanyAuthedRequest).user?.id;
    try {
      const run = await createPayrollRun(
        companyId,
        { month: monthNum, year: yearNum },
        userId,
      );
      return apiResponse.created(res, run);
    } catch (err) {
      if (err instanceof PayrollRunDuplicateError) {
        return apiResponse.badRequest(res, err.message);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
