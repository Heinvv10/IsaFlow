/**
 * GET /api/billing/plans — public plan catalog for the authenticated tenant.
 * Used by the compare-plans page so PAYG tenants can see what a subscription
 * would cost without going through the admin console.  Returns only active
 * (non-archived) plans; prices and limits are public.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { listPlans } from '@/modules/admin/services/planService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const plans = await listPlans(false);
  return apiResponse.success(res, plans);
}

export default withAuth(withErrorHandler(handler));
