/**
 * Admin Remove User From Company API
 * DELETE /api/admin/users/[id]/remove-from-company — Remove a user from a company
 *
 * 404 when the user is not linked to the company (the delete used to answer
 * 200 whatever it matched); 409 for the company's last owner. Only those
 * refusals are caught: any other error, a failed audit write included,
 * propagates as a 500 and withPlatformAdmin rolls the removal back.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import {
  removeUserFromCompany, CompanyMembershipError, MEMBERSHIP_ERROR_CODE,
} from '@/modules/admin/services/companyMembershipService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const DeleteBody = z.object({
  company_id: UUID,
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'DELETE') {
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'company_id must be a valid UUID');
    }
    const { company_id } = parsed.data;

    let previousRole: string;
    try {
      ({ previousRole } = await removeUserFromCompany(userId, company_id));
    } catch (err) {
      if (err instanceof CompanyMembershipError) {
        return apiResponse.error(res, MEMBERSHIP_ERROR_CODE[err.code], err.message);
      }
      throw err;
    }

    await logAdminAction(
      req.user.id,
      'user.remove_from_company',
      'user',
      userId,
      { company_id, previous_role: previousRole },
      getIp(req)
    );

    return apiResponse.success(res, { removed: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['DELETE']);
}

export default withAdmin(withCsrf(handler));
