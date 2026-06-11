/**
 * GET /api/payroll/parallel-run/export?importId=<uuid>[&runId=<uuid>]
 *
 * CSV download of the parallel-run comparison: one row per employee per
 * compared component plus grand totals. 409 when no IsaFlow run exists for
 * the import's period (nothing to compare yet).
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
import { log } from '@/lib/logger';
import { getParallelRunReport } from '@/modules/accounting/services/payroll/payrollParallelRunReportService';
import { buildParallelRunComparisonCsv } from '@/modules/accounting/services/payroll/payrollParallelRunCsv';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const importId = String(req.query.importId ?? '');
  if (!importId) return apiResponse.badRequest(res, 'Missing importId');
  const runId = req.query.runId ? String(req.query.runId) : undefined;

  let report;
  try {
    report = await getParallelRunReport(companyId, importId, runId);
  } catch (err) {
    return apiResponse.badRequestFromError(res, err, 'Comparison failed');
  }
  if (!report) return apiResponse.notFound(res, 'Import not found');
  if (!report.comparison) {
    return apiResponse.conflict(res, 'No IsaFlow payroll run exists for this period yet');
  }

  const csv = buildParallelRunComparisonCsv(report.comparison);
  const fileName = `parallel-run_${report.import.periodYear}-${String(report.import.periodMonth).padStart(2, '0')}.csv`;
  log.info('Parallel-run comparison exported', { companyId, importId }, 'parallelRunExport');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.status(200).send(csv);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
