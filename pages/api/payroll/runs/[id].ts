/**
 * Payroll Run Detail API
 * GET /api/payroll/runs/[id]  - Get a single payroll run + its lines
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
import { describePayRunApproval } from '@/modules/accounting/services/payroll/payRunApprovalControl';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid run ID');

  const run = await getPayrollRun(id, companyId);
  if (!run) return apiResponse.notFound(res, 'PayrollRun', id);

  const lines = await getPayrollRunLines(id, companyId);
  const approval = run.status === 'draft' || run.status === 'calculated'
    ? await describePayRunApproval(companyId, id) : null;
  return apiResponse.success(res, { ...run, lines, approval });
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
