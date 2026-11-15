/**
 * Admin Analytics Trends API
 * GET /api/admin/analytics/trends — 30-day daily MRR, engagement and signup time series
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getTrends } from '@/modules/admin/services/trendsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const trends = await getTrends();
    return apiResponse.success(res, trends);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
