/**
 * Admin Analytics Trends API
 * GET /api/admin/analytics/trends — 30-day daily MRR, engagement and signup time series
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getTrends } from '@/modules/admin/services/analyticsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const trends = await getTrends();
      return apiResponse.success(res, trends);
    } catch (err) {
      log.error('Failed to get analytics trends', { error: err }, 'admin-trends-api');
      return apiResponse.badRequest(res, 'Failed to get analytics trends');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
