/**
 * Due by date report, Excel export
 * GET /api/accounting/reports/due-by-date-xlsx?by_date=YYYY-MM-DD
 * Same by_date and figures as /reports/due-by-date, with every invoice.
 * Errors are not logged here: withErrorHandler logs a thrown error once.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
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
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
