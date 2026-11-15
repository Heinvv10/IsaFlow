/**
 * Admin User Force Logout API
 * POST /api/admin/users/[id]/force-logout — Invalidate all active sessions for a user
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminStoredUser } from '@/modules/admin/services/storedUserId';
import { apiResponse } from '@/lib/apiResponse';
import { forceLogout } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = (await adminStoredUser(req.query.id)).id; // the stored id: acted on and audited exactly

  if (req.method === 'POST') {
    await forceLogout(userId);

    await logAdminAction(
      req.user.id,
      'user.force_logout',
      'user',
      userId,
      null,
      getIp(req)
    );

    return apiResponse.success(res, { logged_out: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
