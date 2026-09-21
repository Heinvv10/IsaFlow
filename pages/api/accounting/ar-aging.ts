/**
 * AR Aging Report API
 * GET /api/accounting/ar-aging
 *   ?as_at_date=YYYY-MM-DD  - optional, defaults to today
 *   ?client_id=UUID          - optional, returns detail for single client
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { getUnappliedByEntity, netAgingRows } from '@/modules/accounting/services/shared/agedNetting';
import { getARAging, getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { as_at_date, client_id } = req.query;
    const asAtDate = as_at_date ? String(as_at_date) : undefined;

    if (client_id) {
      const detail = await getARAgingDetail(companyId, String(client_id), asAtDate);
      return apiResponse.success(res, detail);
    }

    // Each row keeps its GROSS buckets and its gross `total` — existing callers
    // read that and it is the figure reconcile_subledger compares against — and
    // gains `unapplied` (negative) and `net` beside them, so the UI can show
    // what a customer actually owes once the credit standing against their name
    // is taken off. See services/shared/agedNetting.
    const buckets = await getARAging(companyId, asAtDate);
    const unapplied = await getUnappliedByEntity(
      companyId, 'ar', asAtDate ?? fmtDate(new Date()),
    );
    return apiResponse.success(res, netAgingRows(buckets, unapplied));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get AR aging';
    log.error('Failed to get AR aging', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
