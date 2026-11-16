/**
 * SARS Compliance Calendar API
 * GET ?year=YYYY — get compliance calendar with upcoming deadlines
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { getComplianceCalendarWithDB } from '@/modules/accounting/services/reports/sarsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const rawYear = req.query.year;
  const year = rawYear === undefined ? undefined : Number(rawYear);
  if (year !== undefined && !(Number.isInteger(year) && year >= 2000 && year <= 2100)) {
    return apiResponse.badRequest(res, 'year must be a whole number from 2000 to 2100');
  }
  // A service failure (e.g. the company row cannot be read) is a server error:
  // it propagates to withErrorHandler (5xx), never a 400.
  const events = await getComplianceCalendarWithDB(companyId, year);
  return apiResponse.success(res, { events });
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
