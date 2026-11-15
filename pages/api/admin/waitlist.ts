/**
 * Admin Waitlist List API
 * GET /api/admin/waitlist — list pre-launch signups (pending | promoted | all).
 */

import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth/withPlatformAdmin';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminPaging } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { listWaitlistSignups } from '@/modules/onboarding/services/waitlistPromotionService';

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { status, search, page, limit } = req.query;
  const statusFilter = (status === 'promoted' || status === 'all') ? status : 'pending';

  const result = await listWaitlistSignups({
    status: statusFilter,
    search: typeof search === 'string' ? search : undefined,
    ...adminPaging({ page, limit }),
  });

  return apiResponse.success(res, result);
}

export default withAdmin(handler);
