/**
 * POST /api/payroll/runs/[id]/cancel - cancel a draft or calculated off-cycle run (wave 6 OC, UI review #1620 H).
 * Owner or admin only; refused under Login-as (403 IMPERSONATION_FORBIDDEN); every other refusal is a 409 judged
 * before any write (payrollOffCycleCancel).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ApprovalDecisionError } from '@/modules/accounting/services/gl/approvalAuthority';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { cancelOffCycleRun } from '@/modules/accounting/services/payroll/payrollOffCycleCancel';
import { OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (companyRole !== 'owner' && companyRole !== 'admin') {
    return apiResponse.forbidden(res, 'Only an owner or admin can cancel an off-cycle run.');
  }
  const id = String(req.query.id);
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');
  try {
    const run = await cancelOffCycleRun(companyId, id, req.user?.id ?? null);
    if (!run) return apiResponse.notFound(res, 'PayrollRun', id);
    return apiResponse.success(res, run);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof OffCycleRunRefusedError) return apiResponse.conflict(res, err.message, { code: err.code });
    // Withdrawing the run's pending approval request was refused (approval_request_decide): nothing was written.
    if (err instanceof ApprovalDecisionError) return apiResponse.error(res, ErrorCode.FORBIDDEN, err.message, { reason: err.code });
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
