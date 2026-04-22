/**
 * Practice Staff Rates API
 * GET  /api/accounting/practice/staff-rates?userId=...  - List staff rates for a user
 * POST /api/accounting/practice/staff-rates              - Create a staff rate
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listStaffRates,
  createStaffRate,
} from '@/modules/accounting/services/practice/practiceStaffRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) return apiResponse.badRequest(res, 'userId is required');
    const result = await listStaffRates(companyId, userId as string);
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const { userId, rate, currency, effectiveFrom, effectiveTo } = req.body;
    if (!userId) return apiResponse.badRequest(res, 'userId is required');
    if (rate === undefined || rate === null) return apiResponse.badRequest(res, 'rate is required');
    if (!effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');
    if (effectiveTo && String(effectiveTo) <= String(effectiveFrom)) {
      return apiResponse.badRequest(res, 'effectiveTo must be after effectiveFrom');
    }
    const staffRate = await createStaffRate(companyId, {
      userId,
      rate: Number(rate),
      currency,
      effectiveFrom,
      effectiveTo,
    });
    return apiResponse.created(res, staffRate);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
