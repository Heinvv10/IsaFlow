/**
 * Admin Dashboard Stats API
 * GET /api/admin/dashboard-stats — Platform-wide aggregate KPIs
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getDashboardStats } from '@/modules/admin/services/adminDashboardService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const stats = await getDashboardStats();
    return apiResponse.success(res, stats);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
