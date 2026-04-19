/**
 * Practice Staff Cost Rates API
 * GET  /api/accounting/practice/staff-cost-rates?userId=...  - List cost rates (optional filter)
 * POST /api/accounting/practice/staff-cost-rates              - Create a cost rate
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listCostRates,
  createCostRate,
} from '@/modules/accounting/services/practice/practiceCostRateService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const actorId = req.user.id;

  if (req.method === 'GET') {
    const { userId } = req.query;
    const result = await listCostRates(companyId, userId as string | undefined);
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const { userId, costRate, currency, effectiveFrom, effectiveTo, notes } = req.body as Record<string, unknown>;
    if (!userId) return apiResponse.badRequest(res, 'userId is required');
    if (costRate === undefined || costRate === null) return apiResponse.badRequest(res, 'costRate is required');
    if (!effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');

    const created = await createCostRate(companyId, actorId, {
      userId: userId as string,
      costRate: Number(costRate),
      currency: currency as string | undefined,
      effectiveFrom: effectiveFrom as string,
      effectiveTo: effectiveTo as string | null | undefined,
      notes: notes as string | null | undefined,
    });
    return apiResponse.created(res, created);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
