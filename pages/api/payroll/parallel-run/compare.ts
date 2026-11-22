/**
 * GET /api/payroll/parallel-run/compare?importId=<uuid>[&runId=<uuid>]
 *
 * Per-employee, per-component cent-level comparison of the IsaFlow payroll
 * run vs the imported external payslip dataset. When runId is omitted the
 * run is resolved by the import's period; `run`/`comparison` come back null
 * when no IsaFlow run exists for that period yet.
 */

import type { NextApiResponse } from 'next';
import { respondIfRunKindUnsupported } from '@/lib/apiRunKindUnsupported';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { getParallelRunReport } from '@/modules/accounting/services/payroll/payrollParallelRunReportService';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const importId = String(req.query.importId ?? '');
  if (!importId) return apiResponse.badRequest(res, 'Missing importId');
  const runId = req.query.runId ? String(req.query.runId) : undefined;

  try {
    const report = await getParallelRunReport(companyId, importId, runId);
    if (!report) return apiResponse.notFound(res, 'Import not found');
    return apiResponse.success(res, report);
  } catch (err) {
    if (respondIfRunKindUnsupported(res, err)) return; // a run not found (deleted draft, stale link): 404
    return apiResponse.badRequestFromError(res, err, 'Comparison failed');
  }
}

export default withAuth(withErrorHandler(withPayrollModule(withCsrf(withPayrollDetailAccess(handler)))));
