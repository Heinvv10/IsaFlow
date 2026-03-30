/**
 * Custom Report Run API
 * POST /api/accounting/custom-reports-run
 * Executes a report configuration and returns rows + totals
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { runReport, type ReportConfig } from '@/modules/accounting/services/customReportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const body = req.body as ReportConfig & { limit?: number; offset?: number };

  if (!body.dataSource) return apiResponse.badRequest(res, 'dataSource is required');
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return apiResponse.badRequest(res, 'At least one column is required');
  }

  const config: ReportConfig = {
    dataSource: body.dataSource,
    columns: body.columns,
    filters: body.filters ?? [],
    sortBy: body.sortBy ?? [],
    groupBy: body.groupBy ?? [],
    limit: body.limit ?? 500,
    offset: body.offset ?? 0,
  };

  try {
    const result = await runReport(companyId, config);
    log.info('Report run via API', { dataSource: config.dataSource, rowCount: result.rowCount, companyId }, 'CustomReportsRunAPI');
    return apiResponse.success(res, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Report execution failed';
    if (msg.includes('Unknown data source') || msg.includes('No valid columns')) {
      return apiResponse.badRequest(res, msg);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
