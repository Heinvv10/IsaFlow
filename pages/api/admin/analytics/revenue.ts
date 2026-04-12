/**
 * Admin Revenue Intelligence API
 * GET /api/admin/analytics/revenue — plan breakdown, churn trend, NRR, ARPU, LTV, cohort retention
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getRevenueIntelligence } from '@/modules/admin/services/revenueService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const data = await getRevenueIntelligence();
      return apiResponse.success(res, data);
    } catch (err) {
      log.error('Failed to get revenue intelligence', { error: err }, 'admin-revenue-api');
      return apiResponse.badRequest(res, 'Failed to get revenue intelligence');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
