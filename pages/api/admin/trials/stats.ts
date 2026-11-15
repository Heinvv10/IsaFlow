/**
 * Admin Trials Stats API
 * GET /api/admin/trials/stats — aggregate trial lifecycle stats
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getTrialStats } from '@/modules/admin/services/trialService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const stats = await getTrialStats();
    return apiResponse.success(res, stats);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
