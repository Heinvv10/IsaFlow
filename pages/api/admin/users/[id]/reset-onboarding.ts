/**
 * Admin Reset User Onboarding API
 * POST /api/admin/users/[id]/reset-onboarding — Reset onboarding so user goes through company wizard again
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminUserId } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { resetOnboarding, SoleOwnerError } from '@/modules/admin/services/adminUserActionsService';
import { PayRunApproverProtectedError } from '@/modules/accounting/services/core/payRunApproverGuard';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = adminUserId(req.query.id);

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
      // A company's only owner (migration 908b): nothing was reset.
      if (err instanceof SoleOwnerError || err instanceof PayRunApproverProtectedError) return apiResponse.conflict(res, err.message);
      throw err; // anything else is a 500 that rolls back
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
