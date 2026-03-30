/**
 * Admin User Reset Password API
 * POST /api/admin/users/[id]/reset-password — Generate a temporary password
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { resetPassword } from '@/modules/admin/services/adminUserService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      const temporaryPassword = await resetPassword(userId);

      await logAdminAction(
        req.user.id,
        'user.reset_password',
        'user',
        userId,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { temporary_password: temporaryPassword });
    } catch (err) {
      log.error('Failed to reset user password', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to reset user password');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
