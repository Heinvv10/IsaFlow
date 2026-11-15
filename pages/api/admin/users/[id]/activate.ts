/**
 * Admin User Activate API
 * POST /api/admin/users/[id]/activate — Reactivate a suspended user
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminStoredUser } from '@/modules/admin/services/storedUserId';
import { apiResponse } from '@/lib/apiResponse';
import { activateUser } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = (await adminStoredUser(req.query.id)).id; // the stored id: acted on and audited exactly

  if (req.method === 'POST') {
    // A missing user is a 404 before the audit row: the refusal writes nothing (breaker #1405 B5).
    if (!(await activateUser(userId))) return apiResponse.notFound(res, 'User', userId);

    await logAdminAction(
      req.user.id,
      'user.activate',
      'user',
      userId,
      {},
      getIp(req)
    );

    return apiResponse.success(res, { activated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
