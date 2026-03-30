/**
 * Admin Usage Analytics API
 * GET /api/admin/analytics/usage — DAU/WAU/MAU, feature adoption, churn signals
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
