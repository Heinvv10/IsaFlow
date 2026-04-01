/**
 * CaseWare Export API — WS-7.3
 * GET /api/accounting/caseware-export?period_start=X&period_end=Y
 * Downloads a CaseWare-compatible trial balance CSV.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { exportCaseWareTB } from '@/modules/accounting/services/casewareExportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  if (!periodStart || !periodEnd) {
    return apiResponse.badRequest(res, 'period_start and period_end are required');
  }

  log.info('CaseWare export requested', { companyId, periodStart, periodEnd }, 'caseware-export-api');

  try {
    const csv = await exportCaseWareTB(companyId, periodStart, periodEnd);
    const filename = `caseware-tb-${periodStart}-to-${periodEnd}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('CaseWare export failed', { error: err, companyId }, 'caseware-export-api');
    return apiResponse.badRequest(res, 'Failed to generate CaseWare export');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
