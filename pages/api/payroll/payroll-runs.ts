/**
 * Payroll Runs API
 * GET  /api/payroll/payroll-runs  - List all payroll runs
 * POST /api/payroll/payroll-runs  - Create a new payroll run
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listPayrollRuns, createPayrollRun } from '@/modules/payroll/payrollService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const runs = await listPayrollRuns();
      return apiResponse.success(res, runs);
    } catch (err) {
      log.error('payroll runs GET failed', { error: err }, 'payroll-api');
      return apiResponse.internalError(res, err, 'Failed to fetch payroll runs');
    }
  }

  if (req.method === 'POST') {
    try {
      const { period_start, period_end } = req.body;

      if (!period_start || !period_end) {
        return apiResponse.badRequest(res, 'period_start and period_end are required');
      }

      const userId = req.user.id;
      const run = await createPayrollRun(period_start, period_end, userId);
      return apiResponse.success(res, run);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create payroll run';
      log.error('payroll runs POST failed', { error: err }, 'payroll-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
