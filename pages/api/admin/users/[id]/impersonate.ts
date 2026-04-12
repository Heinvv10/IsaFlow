/**
 * Admin User Impersonation API
 * POST /api/admin/users/[id]/impersonate
 *
 * Creates a 1-hour impersonation session allowing a super_admin to log in
 * as the target user in the main application.
 *
 * Guards:
 *  - Target must exist and be active.
 *  - Admin cannot impersonate another super_admin.
 *  - Rate-limited (5 per minute via withAdmin outer layer).
 *  - Every attempt is written to admin_audit_log.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { createUserImpersonationSession } from '@/modules/admin/services/userImpersonationService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const targetId = req.query.id as string;
  if (!targetId) {
    return apiResponse.badRequest(res, 'User ID is required');
  }

  // Per-admin impersonation rate limit: 5 per minute
  if (checkRateLimit(`user-impersonate:${req.user.id}`, { windowMs: 60_000, maxRequests: 5 })) {
    res.status(429).json({
      success: false,
      error: {
        code:    'RATE_LIMITED',
        message: 'Too many impersonation attempts. Please wait a minute.',
      },
    });
    return;
  }

  const ip = getIp(req);

  try {
    const result = await createUserImpersonationSession(
      req.user.id,
      targetId,
      ip ?? undefined
    );

    // Audit log — user.impersonate is treated as a critical action
    await logAdminAction(
      req.user.id,
      'user.impersonate',
      'user',
      targetId,
      { target_email: result.user.email, session_id: result.sessionId },
      ip
    );

    return apiResponse.success(res, {
      token: result.token,
      user:  result.user,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create impersonation session';

    // Business-rule rejections (not found, inactive, role conflict) — 400
    if (
      msg === 'Target user not found' ||
      msg === 'Cannot impersonate an inactive user' ||
      msg === 'Cannot impersonate another super_admin'
    ) {
      log.warn('User impersonation rejected', { adminId: req.user.id, targetId, reason: msg }, 'admin-api');
      return apiResponse.badRequest(res, msg);
    }

    log.error('User impersonation failed', { adminId: req.user.id, targetId, error: err }, 'admin-api');
    return apiResponse.internalError(res, 'Failed to create impersonation session');
  }
}

export default withAdmin(handler);
