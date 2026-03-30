/**
 * Admin Platform Health API
 * GET /api/admin/analytics/health — Active users, DB size, error rate
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
