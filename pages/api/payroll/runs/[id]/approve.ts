/**
 * POST /api/payroll/runs/[id]/approve
 * Approve a payroll run and post its GL journal entry.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id);

  if (!UUID_RE.test(id)) {
    return apiResponse.badRequest(res, 'Invalid payroll run ID');
  }

  try {
    const result = await approvePayrollRun(companyId, id, user.id);
    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiResponse.badRequest(res, message);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
