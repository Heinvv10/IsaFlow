/**
 * GET /api/payroll/runs/[id]/journal-plan
 * The journal approving this run would post, and the blocker approval would
 * refuse with — read-only, for the approval confirmation (PAY-01). Built by
 * the same plan builder the poster consumes, so the preview cannot disagree
 * with what posts. Only a role that can approve (withWriteAccess's default
 * set, which approve.ts applies) may read it: it shows the run's payroll
 * amounts, and no one else needs the confirmation. GET-only, so no withCsrf.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { canWrite } from '@/lib/auth/writeRoles';
import { previewPayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { toJournalPlanPreview } from '@/modules/accounting/services/payroll/payrollApprovalGate';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (!canWrite(companyRole)) {
    return apiResponse.forbidden(res, `Your role (${companyRole}) does not allow approving payroll.`);
  }
  const id = String(req.query.id);
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');

  const preview = await previewPayrollApproval(companyId, id);
  if (!preview) return apiResponse.notFound(res, 'PayrollRun', id);
  return apiResponse.success(res, toJournalPlanPreview(preview));
}

export default withAuth(withErrorHandler(handler));
