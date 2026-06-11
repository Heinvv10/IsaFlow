/**
 * GET /api/payroll/parallel-run/compare?importId=<uuid>[&runId=<uuid>]
 *
 * Per-employee, per-component cent-level comparison of the IsaFlow payroll
 * run vs the imported external payslip dataset. When runId is omitted the
 * run is resolved by the import's period; `run`/`comparison` come back null
 * when no IsaFlow run exists for that period yet.
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
import { getParallelRunReport } from '@/modules/accounting/services/payroll/payrollParallelRunReportService';

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
    return apiResponse.badRequestFromError(res, err, 'Comparison failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
