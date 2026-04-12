/**
 * Admin Trials Stats API
 * GET /api/admin/trials/stats — aggregate trial lifecycle stats
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getTrialStats } from '@/modules/admin/services/trialService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const stats = await getTrialStats();
      return apiResponse.success(res, stats);
    } catch (err) {
      log.error('Failed to get trial stats', { error: err }, 'admin-trials-stats-api');
      return apiResponse.badRequest(res, 'Failed to get trial stats');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
