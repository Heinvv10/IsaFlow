/**
 * POST /api/payroll/runs/[id]/cancel - cancel a draft or calculated off-cycle run (wave 6 OC, UI review #1620 H).
 * Owner or admin only; refused under Login-as (403 IMPERSONATION_FORBIDDEN); every other refusal is a 409 judged
 * before any write (payrollRunCancel).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ApprovalDecisionError, ApprovalRequestNotFoundError } from '@/modules/accounting/services/gl/approvalAuthority';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { refuseWithoutApprove } from '@/modules/accounting/services/core/approvePermissionResponse';
import { cancelOffCycleRun } from '@/modules/accounting/services/payroll/payrollRunCancel';
import { OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  if (companyRole !== 'owner' && companyRole !== 'admin') {
    return apiResponse.forbidden(res, 'Only an owner or admin can cancel an off-cycle run.');
  }
  const id = String(req.query.id);
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');
  // Cancelling withdraws the run's pending approval request: it takes Payroll Approve, as reopen does (#1656 census).
  if (await refuseWithoutApprove(res, companyId, user.id, 'payroll', 'pay runs (cancel)')) return;
  try {
    const run = await cancelOffCycleRun(companyId, id, user.id);
    if (!run) return apiResponse.notFound(res, 'PayrollRun', id);
    return apiResponse.success(res, run);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof OffCycleRunRefusedError) return apiResponse.conflict(res, err.message, { code: err.code });
    // Withdrawing the run's pending approval request was refused (approval_request_decide): nothing was written.
    if (err instanceof ApprovalDecisionError) return apiResponse.error(res, ErrorCode.FORBIDDEN, err.message, { reason: err.code });
    // The run's request held past the lock budget: 503 + Retry-After with the lock's code, as approval-requests answers it.
    if (respondIfLockTimeout(res, err)) return;
    // Its request was no longer pending when withdrawn (review L3 of 819c2861c0; the lock makes it unexpected): 404, as
    // approval-requests answers it, with a code.
    if (err instanceof ApprovalRequestNotFoundError) {
      return apiResponse.error(res, ErrorCode.NOT_FOUND, 'This run\'s approval request is no longer pending: reload the run and try again.',
        { code: 'APPROVAL_REQUEST_NOT_FOUND' });
    }
    throw err;
  }
}

// Payroll-detail roles, like the run detail routes (review #1620 security).
export default withAuth(withErrorHandler(withPayrollModule(withCsrf(withPayrollDetailAccess(withWriteAccess(handler))))));
