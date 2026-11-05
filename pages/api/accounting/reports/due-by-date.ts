/**
 * Due by date report API
 * GET /api/accounting/reports/due-by-date
 *   ?by_date=YYYY-MM-DD - optional, defaults to the end of the current month;
 *                         must be today or later (SAST)
 *
 * Both sides (AP and AR) with their per-contact columns and invoice drill-down,
 * plus the net position (AR totalByDate - AP totalByDate). Current balances only.
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
    return apiResponse.success(res, await getDueByDateReport(companyId, byDate));
  } catch (err) {
    if (err instanceof DueByDateInputError) return apiResponse.badRequest(res, err.message);
    log.error('Failed to get due-by-date report', { error: err }, 'accounting-api');
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
