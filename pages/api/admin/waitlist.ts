/**
 * Admin Waitlist List API
 * GET /api/admin/waitlist — list pre-launch signups (pending | promoted | all).
 */

import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth/withPlatformAdmin';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listWaitlistSignups } from '@/modules/onboarding/services/waitlistPromotionService';

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  try {
    const { status, search, page, limit } = req.query;
    const statusFilter = (status === 'promoted' || status === 'all') ? status : 'pending';

    const result = await listWaitlistSignups({
      status: statusFilter,
      search: typeof search === 'string' ? search : undefined,
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
    });

    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to list waitlist signups', { error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Failed to list waitlist signups');
  }
}

export default withAdmin(handler);
