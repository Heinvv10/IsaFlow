/**
 * Time Summary API
 * GET — returns time tracking summary with optional filters
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { getTimeSummary } from '@/modules/accounting/services/core/timeTrackingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { dateFrom, dateTo, userId } = req.query;

  const summary = await getTimeSummary(companyId, {
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
    userId: userId as string,
  });

  return apiResponse.success(res, summary);
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
