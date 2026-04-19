/**
 * Practice Rate Resolve API
 * GET /api/accounting/practice/rate-resolve?userId=...&clientId=...&date=...
 *     - Resolve effective rate for a staff member / client / date combination
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { resolveRate } from '@/modules/accounting/services/practice/practiceStaffRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { userId, clientId, date } = req.query;
    if (!userId) return apiResponse.badRequest(res, 'userId is required');
    if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
    if (!date) return apiResponse.badRequest(res, 'date is required');
    const rate = await resolveRate(companyId, userId as string, clientId as string, date as string);
    return apiResponse.success(res, { rate });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
}

export default withAuth(withErrorHandler(handler));
