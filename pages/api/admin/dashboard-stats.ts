/**
 * Admin Dashboard Stats API
 * GET /api/admin/dashboard-stats — Platform-wide aggregate KPIs
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getDashboardStats } from '@/modules/admin/services/adminDashboardService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const stats = await getDashboardStats();
      return apiResponse.success(res, stats);
    } catch (err) {
      log.error('Failed to get dashboard stats', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get dashboard stats');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
