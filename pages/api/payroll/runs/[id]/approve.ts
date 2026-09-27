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
import {
  PayrollApprovalRefusedError,
  approvePayrollRun,
} from '@/modules/accounting/services/payroll/payrollApprovalService';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';

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
    if (respondIfImpersonationForbidden(res, err)) return;
    // Only a refusal raised before the status write is a 400. withAuth COMMITs
    // a 4xx, so anything else is rethrown: it may follow the write, and the
    // 500 rolls the request back rather than stranding an approved run (K-079).
    if (err instanceof PayrollApprovalRefusedError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
