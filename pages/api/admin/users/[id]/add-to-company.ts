/**
 * Admin Add User To Company API
 * POST /api/admin/users/[id]/add-to-company — Add a user to a company with a given role
 *
 * 409 when the user is already linked to the company: this used to upsert the
 * role, which could demote a company's last owner unchecked; a linked
 * company's role changes only through PATCH company-role. 400 for a role the
 * portal may not grant. Only those refusals are caught: any other error, a
 * failed audit write included, propagates as a 500 and withPlatformAdmin rolls
 * the link back.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import {
  addUserToCompany, CompanyMembershipError, MEMBERSHIP_ERROR_CODE,
} from '@/modules/admin/services/companyMembershipService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  company_id: UUID,
  role:       z.string().min(1).max(50),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }
    const { company_id, role } = parsed.data;

    try {
      await addUserToCompany(userId, company_id, role);
    } catch (err) {
      if (err instanceof CompanyMembershipError) {
        return apiResponse.error(res, MEMBERSHIP_ERROR_CODE[err.code], err.message);
      }
      throw err;
    }

    await logAdminAction(
      req.user.id,
      'user.add_to_company',
      'user',
      userId,
      { company_id, role },
      getIp(req)
    );

    return apiResponse.success(res, { added: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
