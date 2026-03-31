/**
 * Admin Usage Analytics API
 * GET /api/admin/analytics/usage — DAU/WAU/MAU, feature adoption, churn signals
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getUsageAnalytics } from '@/modules/admin/services/analyticsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const analytics = await getUsageAnalytics();
      return apiResponse.success(res, analytics);
    } catch (err) {
      log.error('Failed to get usage analytics', { error: err }, 'admin-analytics-api');
      return apiResponse.badRequest(res, 'Failed to get usage analytics');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
