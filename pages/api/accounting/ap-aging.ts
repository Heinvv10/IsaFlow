/**
 * AP Aging Report API
 * GET /api/accounting/ap-aging - AP aging buckets by supplier
 * GET /api/accounting/ap-aging?supplier_id=123 - Aging detail for one supplier
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { getUnappliedByEntity, netAgingRows } from '@/modules/accounting/services/shared/agedNetting';
import { getAPAging, getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { supplier_id, as_at_date } = req.query;
    const asAtDate = as_at_date as string | undefined;

    if (supplier_id) {
      const detail = await getAPAgingDetail(companyId, supplier_id as string, asAtDate);
      return apiResponse.success(res, detail);
    }

    // Each row keeps its GROSS buckets and its gross `total` — existing callers
    // read that and it is the figure reconcile_subledger compares against — and
    // gains `unapplied` (negative) and `net` beside them, so the UI can show
    // what is actually owed to a supplier once the credit standing against their
    // name is taken off. See services/shared/agedNetting.
    const aging = await getAPAging(companyId, asAtDate);
    const unapplied = await getUnappliedByEntity(
      companyId, 'ap', asAtDate ?? fmtDate(new Date()),
    );
    return apiResponse.success(res, netAgingRows(aging, unapplied));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get AP aging';
    log.error('Failed to get AP aging', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
