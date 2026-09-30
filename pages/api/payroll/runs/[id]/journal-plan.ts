/**
 * GET /api/payroll/runs/[id]/journal-plan
 * The journal approving this run would post, and the blocker approval would
 * refuse with — read-only, for the approval confirmation (PAY-01). Built by
 * the same plan builder the poster consumes, so the preview cannot disagree
 * with what posts.
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
import { previewPayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id);
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');

  const preview = await previewPayrollApproval(companyId, id);
  if (!preview) return apiResponse.notFound(res, 'PayrollRun', id);
  return apiResponse.success(res, preview);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
