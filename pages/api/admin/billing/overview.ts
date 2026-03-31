/**
 * Admin Billing Overview API
 * GET /api/admin/billing/overview — Platform-wide billing KPIs
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getBillingOverview } from '@/modules/admin/services/billingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const overview = await getBillingOverview();
      return apiResponse.success(res, overview);
    } catch (err) {
      log.error('Failed to get billing overview', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get billing overview');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
