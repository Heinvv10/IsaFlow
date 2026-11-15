/**
 * Admin Usage Analytics API
 * GET /api/admin/analytics/usage — DAU/WAU/MAU, feature adoption, churn signals
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getUsageAnalytics } from '@/modules/admin/services/analyticsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const analytics = await getUsageAnalytics();
    return apiResponse.success(res, analytics);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
