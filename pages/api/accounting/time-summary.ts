/**
 * Time Summary API
 * GET — returns time tracking summary with optional filters
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { getTimeSummary } from '@/modules/accounting/services/timeTrackingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { dateFrom, dateTo, userId } = req.query;

  const summary = await getTimeSummary(companyId, {
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
    userId: userId as string,
  });

  return apiResponse.success(res, summary);
}

 
export default withCompany(withErrorHandler(withWriteAccess(handler)));
