/**
 * Payroll Run Actions API
 * POST /api/payroll/payroll-runs-action  - Execute action (complete, reverse)
 * Body: { runId: string, action: 'complete' | 'reverse' }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  completePayrollRun,
  reversePayrollRun,
} from '@/modules/payroll/payrollService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { runId, action } = req.body;

  if (!runId) {
    return apiResponse.badRequest(res, 'runId is required');
  }
  if (!action || !['complete', 'reverse'].includes(action)) {
    return apiResponse.badRequest(res, 'action must be "complete" or "reverse"');
  }

  const userId = req.user.id;

  try {
    let result;
    if (action === 'complete') {
      result = await completePayrollRun(companyId, runId, userId);
    } else {
      result = await reversePayrollRun(companyId, runId, userId);
    }
    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : `Failed to ${action} payroll run`;
    log.error(`payroll run ${action} failed`, { runId, error: err }, 'payroll-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
