/**
 * Admin Platform Health API
 * GET /api/admin/analytics/health — Active users, DB size, error rate
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getPlatformHealth } from '@/modules/admin/services/analyticsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const health = await getPlatformHealth();
      return apiResponse.success(res, health);
    } catch (err) {
      log.error('Failed to get platform health', { error: err }, 'admin-analytics-api');
      return apiResponse.badRequest(res, 'Failed to get platform health');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
