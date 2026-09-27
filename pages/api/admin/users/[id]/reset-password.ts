/**
 * Admin User Reset Password API
 * POST /api/admin/users/[id]/reset-password — Email the user a single-use reset link
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { PasswordResetEmailNotSentError } from '@/lib/auth/passwordResetEmail';
import { log } from '@/lib/logger';
import { resetPassword } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      // M6: audit-then-act. The reset email is an external side-effect a tx
      // rollback cannot undo, so the (critical) audit row is written first: a
      // failed audit throws BEFORE anything is sent.
      await logAdminAction(
        req.user.id,
        'user.reset_password',
        'user',
        userId,
        null,
        getIp(req)
      );

      // R-032 M2: the link goes to the user only — never into this response.
      await resetPassword(userId);

      log.info('Password reset performed', { userId }, 'admin-api');
      return apiResponse.success(res, { message: 'Password reset email sent' });
    } catch (err) {
      if (err instanceof PasswordResetEmailNotSentError) {
        log.error('Password reset email not sent', { userId, error: err.message }, 'admin-api');
        return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE,
          'The password reset email could not be sent. The user has not been emailed.');
      }
      log.error('Failed to reset user password', { userId, error: err }, 'admin-api');
      return apiResponse.internalError(res, err, 'Failed to reset user password');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
