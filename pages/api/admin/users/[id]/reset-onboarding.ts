/**
 * Admin Reset User Onboarding API
 * POST /api/admin/users/[id]/reset-onboarding — Reset onboarding so user goes through company wizard again
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { resetOnboarding } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      await resetOnboarding(userId);

      await logAdminAction(
        req.user.id,
        'user.reset_onboarding',
        'user',
        userId,
        {},
        getIp(req)
      );

      return apiResponse.success(res, { reset: true });
    } catch (err) {
      log.error('Failed to reset onboarding', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to reset onboarding');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
