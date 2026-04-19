/**
 * Cancel a payroll run.
 * POST /api/payroll/runs/[id]/cancel — transitions draft|calculated|approved → cancelled.
 * If run was approved, the posted GL journal entry is reversed first.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { cancelPayrollRun } from '@/modules/accounting/services/payroll/payrollLifecycleService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const { companyId, user } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid run ID');

  const summary = await cancelPayrollRun(companyId, String(user.id), id);
  return apiResponse.success(res, summary);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
