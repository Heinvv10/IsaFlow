/**
 * Admin Billing Overview API
 * GET /api/admin/billing/overview — Platform-wide billing KPIs
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getBillingOverview } from '@/modules/admin/services/billingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const overview = await getBillingOverview();
    return apiResponse.success(res, overview);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
