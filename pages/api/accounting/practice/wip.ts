/**
 * Practice WIP Board API
 * GET /api/accounting/practice/wip — WIP by client (read-only, no write middleware)
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getWipByClient } from '@/modules/accounting/services/practice/practiceWipService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { practiceClientId, partnerId, dateFrom, dateTo } = req.query;
  const rows = await getWipByClient(companyId, {
    practiceClientId: practiceClientId as string | undefined,
    partnerId: partnerId as string | undefined,
    dateFrom: dateFrom as string | undefined,
    dateTo: dateTo as string | undefined,
  });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
