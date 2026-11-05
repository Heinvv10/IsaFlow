/**
 * Due by date report, Excel export
 * GET /api/accounting/reports/due-by-date-xlsx?by_date=YYYY-MM-DD
 * Same parameters and figures as /reports/due-by-date.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { endOfMonth } from '@/modules/accounting/utils/dueByDate';
import {
  appToday,
  DueByDateInputError,
  getDueByDateReport,
} from '@/modules/accounting/services/reports/dueByDateService';
import { buildDueByDateWorkbook } from '@/modules/accounting/services/reports/dueByDateXlsx';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const raw = req.query.by_date;
  if (raw !== undefined && typeof raw !== 'string') {
    return apiResponse.badRequest(res, 'by_date must be a single YYYY-MM-DD date');
  }
  const byDate = raw || endOfMonth(appToday());

  try {
    const report = await getDueByDateReport(companyId, byDate);
    const wb = buildDueByDateWorkbook(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="due-by-date-${byDate}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (err instanceof DueByDateInputError) return apiResponse.badRequest(res, err.message);
    log.error('Failed to export due-by-date report', { error: err }, 'accounting-api');
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
