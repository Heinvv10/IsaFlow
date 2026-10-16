/**
 * Admin Change Company Role API
 * PATCH /api/admin/users/[id]/company-role — change a linked user's role in one company
 *
 * Body: { company_id, role }. The role must be one the portal may grant
 * (ALLOWED_COMPANY_ROLES; migration 883 refuses `owner` from the portal too).
 * 404 when the user is not linked to the company; 409 when the change would
 * demote the company's last owner. Audited as `user.change_company_role`;
 * any other error, a failed audit write included, propagates as a 500 and
 * withPlatformAdmin rolls the change back.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import {
  setUserCompanyRole, CompanyMembershipError, MEMBERSHIP_ERROR_CODE,
} from '@/modules/admin/services/companyMembershipService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PatchBody = z.object({
  company_id: UUID,
  role:       z.string().min(1).max(50),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'company_id and role are required');
    }
    const { company_id, role } = parsed.data;

    let previousRole: string;
    let changed: boolean;
    try {
      ({ previousRole, changed } = await setUserCompanyRole(userId, company_id, role));
    } catch (err) {
      if (err instanceof CompanyMembershipError) {
        return apiResponse.error(res, MEMBERSHIP_ERROR_CODE[err.code], err.message);
      }
      throw err;
    }

    if (changed) {
      await logAdminAction(
        req.user.id,
        'user.change_company_role',
        'user',
        userId,
        { company_id, previous_role: previousRole, role },
        getIp(req)
      );
    }

    return apiResponse.success(res, { role, previous_role: previousRole });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['PATCH']);
}

export default withAdmin(withCsrf(handler));
