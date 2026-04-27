/**
 * Admin User Suspend API
 * POST /api/admin/users/[id]/suspend — Suspend a user and invalidate sessions
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { suspendUser } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  reason: z.string().min(1).max(500),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'A suspension reason is required');
    }

    try {
      const { reason } = parsed.data;

      await suspendUser(userId, reason.trim());

      await logAdminAction(
        req.user.id,
        'user.suspend',
        'user',
        userId,
        { reason },
        getIp(req)
      );

      return apiResponse.success(res, { suspended: true });
    } catch (err) {
      log.error('Failed to suspend user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to suspend user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
