/**
 * Admin User Reset Password API
 * POST /api/admin/users/[id]/reset-password — Generate a temporary password
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { resetPassword } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      // M6: audit-then-act. resetPassword() mints a GoTrue recovery link — an
      // external, non-transactional side-effect that a tx rollback cannot undo.
      // Writing the (critical) audit row first means a failed audit throws
      // BEFORE the link is generated, so a reset can never occur unaudited.
      await logAdminAction(
        req.user.id,
        'user.reset_password',
        'user',
        userId,
        null,
        getIp(req)
      );

      const { reset_link } = await resetPassword(userId);

      log.info('Password reset performed', { userId }, 'admin-api');
      return apiResponse.success(res, {
        success: true,
        message: 'Password reset link generated. Share with the user if they did not receive the email.',
        reset_link,
      });
    } catch (err) {
      log.error('Failed to reset user password', { userId, error: err }, 'admin-api');
      return apiResponse.internalError(res, err, 'Failed to reset user password');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
