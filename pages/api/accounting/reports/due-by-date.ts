/**
 * Due by date report API
 * GET /api/accounting/reports/due-by-date
 *   ?by_date=YYYY-MM-DD - optional, defaults to the end of the current month;
 *                         must be today or later (SAST)
 *   ?side=ap|ar&entity_id=UUID - optional pair: the drill-down for ONE
 *                         supplier / customer, with its invoices
 *
 * Without entity_id: both sides (AP and AR) with their per-contact columns and
 * totals, plus the net position (AR totalByDate - AP totalByDate), and NO
 * invoice lists: those are read per contact, on demand, so the summary stays
 * small however many documents are open. Current balances only.
 *
 * Errors are not logged here: withErrorHandler logs a thrown error once.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { endOfMonth, reportWithoutInvoices, type DueSide } from '@/modules/accounting/utils/dueByDate';
import {
  appToday,
  DueByDateInputError,
  getDueByDateContact,
  getDueByDateReport,
} from '@/modules/accounting/services/reports/dueByDateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { by_date: raw, side, entity_id: entityId } = req.query;
  if (raw !== undefined && typeof raw !== 'string') {
    return apiResponse.badRequest(res, 'by_date must be a single YYYY-MM-DD date');
  }
  const byDate = raw || endOfMonth(appToday());

  try {
    if (entityId !== undefined) {
      if (side !== 'ap' && side !== 'ar') return apiResponse.badRequest(res, 'side must be "ap" or "ar" when entity_id is given');
      if (!isUuidParam(entityId)) return apiResponse.badRequest(res, 'entity_id must be a valid UUID');
      const contact = await getDueByDateContact(companyId, side as DueSide, byDate, entityId);
      if (!contact) return apiResponse.notFound(res, side === 'ap' ? 'Supplier with open bills' : 'Customer with open invoices', entityId);
      return apiResponse.success(res, { today: appToday(), byDate, side, contact });
    }
    return apiResponse.success(res, reportWithoutInvoices(await getDueByDateReport(companyId, byDate)));
  } catch (err) {
    if (err instanceof DueByDateInputError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
