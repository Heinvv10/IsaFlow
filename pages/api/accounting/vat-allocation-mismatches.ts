/**
 * VAT allocation mismatch report — GET, read-only.
 *
 * Lists allocated bank transactions where the screen's VAT code disagrees with
 * the journal it posted, and where input tax was claimed against an account
 * that denies it (s17(2)(a) entertainment). Nothing here writes: use it to
 * scope a retrospective correction, then reverse and re-allocate the journals
 * it names.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=500
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { findVatAllocationMismatches } from '@/modules/accounting/services/reports/vatAllocationMismatchService';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { from, to, limit } = req.query;
  if (from && !ISO_DATE.test(String(from))) {
    return apiResponse.badRequest(res, 'from must be YYYY-MM-DD');
  }
  if (to && !ISO_DATE.test(String(to))) {
    return apiResponse.badRequest(res, 'to must be YYYY-MM-DD');
  }

  const result = await findVatAllocationMismatches(companyId, {
    from: from ? String(from) : undefined,
    to: to ? String(to) : undefined,
    limit: limit ? Number(limit) : undefined,
  });
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler as never));
