/**
 * Payroll Run Detail API
 * GET    /api/payroll/runs/[id]  - Get a single payroll run + its lines
 * DELETE /api/payroll/runs/[id]  - Delete a draft never calculated or approved (write roles, through the
 *                                  payroll-detail gate; own session, never Login-as; wave 6 FQd, payrollRunDelete):
 *                                  409 RUN_NOT_DELETABLE otherwise, 404 when not this company's.
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
import {
  getPayrollRun,
  getPayrollRunLines,
} from '@/modules/accounting/services/payroll/payrollRunService';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { payslipEmailActor, UUID } from '@/lib/payslipEmailApi';
import { deleteDraftPayrollRun, RunNotDeletableError } from '@/modules/accounting/services/payroll/payrollRunDelete';
import { describePayRunApproval } from '@/modules/accounting/services/payroll/payRunApprovalControl';
import { describePayRunDecision } from '@/modules/accounting/services/payroll/payRunDecision';
import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'DELETE']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid run ID');
  if (req.method === 'DELETE') return UUID.test(id) ? deleteRun(req, res, companyId, id) : apiResponse.badRequest(res, 'id must be a UUID');

  const run = await getPayrollRun(id, companyId);
  if (!run) return apiResponse.notFound(res, 'PayrollRun', id);

  const lines = await getPayrollRunLines(id, companyId);
  const approval = run.status === 'draft' || run.status === 'calculated'
    ? await describePayRunApproval(companyId, id) : null;
  // Whether the approval was decided by the requester's own sole-approver self-approval (no ids leave the server).
  const approvalDecision = await describePayRunDecision(companyId, id, run.status);
  // The payslips' final/DRAFT state: `isPayRunFinal`: approved/paid with an approval time, never the status alone (wave 4 PS, wave 5 FS).
  const payslipsFinal = lines.length > 0 && await isPayRunFinal(companyId, id);
  return apiResponse.success(res, { ...run, lines, approval, approvalDecision, payslipsFinal });
}

async function deleteRun(req: AuthenticatedNextApiRequest, res: NextApiResponse, companyId: string, id: string): Promise<void> {
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  try {
    const deleted = await deleteDraftPayrollRun(companyId, id, actor);
    return deleted ? apiResponse.success(res, { id, deleted: true }) : apiResponse.notFound(res, 'PayrollRun', id);
  } catch (err) {
    if (err instanceof RunNotDeletableError) return apiResponse.conflict(res, err.message, { reason: err.code });
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
