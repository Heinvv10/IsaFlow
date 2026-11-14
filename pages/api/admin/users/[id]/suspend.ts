/**
 * Admin User Suspend API
 * POST /api/admin/users/[id]/suspend — Suspend a user and invalidate sessions
 *
 * Atomic with its audit row (admin audit 2026-11-14, 3.2). Only the refusals raised before any write are caught
 * (404, the last active super admin's 409). Every other failure throws: withErrorHandler answers 500 and
 * withPlatformAdmin rolls the suspension back (an admin_request_failed row records the attempt). A failed GoTrue
 * revocation is not a failure of the suspension: it commits, its audit row says `revocation_failed: true`, and
 * the answer says the browser sessions survive (`sessions_revoked: false` and the message).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { suspendUser, SESSIONS_NOT_REVOKED_MESSAGE } from '@/modules/admin/services/adminUserActionsService';
import { assertSuperAdminRemains, LastSuperAdminError } from '@/modules/admin/services/superAdminRosterService';
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

    const { reason } = parsed.data;
    let target;
    try {
      target = await assertSuperAdminRemains(userId);
    } catch (err) {
      if (err instanceof LastSuperAdminError) return apiResponse.conflict(res, err.message, { reason: err.code });
      throw err;
    }
    if (!target) return apiResponse.notFound(res, 'User', userId);

    const { stranded, sessionsRevoked } = await suspendUser(userId, reason.trim());

    await logAdminAction(
      req.user.id,
      'user.suspend',
      'user',
      userId,
      {
        reason,
        revocation_failed: !sessionsRevoked,
        ...(target.isSuperAdmin ? { target_super_admin: true } : {}),
        // Pending pay-run approvals this left without another approver (the suspension is never refused for them).
        ...(stranded.length > 0 ? { stranded_pay_run_requests: stranded } : {}),
      },
      getIp(req)
    );

    if (!sessionsRevoked) {
      log.warn('User suspended; GoTrue sessions not revoked', { userId }, 'admin-api');
      return apiResponse.success(res, { suspended: true, sessions_revoked: false }, SESSIONS_NOT_REVOKED_MESSAGE);
    }
    return apiResponse.success(res, { suspended: true, sessions_revoked: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
