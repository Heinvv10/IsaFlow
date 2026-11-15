/**
 * Admin Remove User From Company API
 * DELETE /api/admin/users/[id]/remove-from-company — Remove a user from a company
 *
 * 404 when the user is not linked to the company (the delete used to answer
 * 200 whatever it matched); 409 for the company's last owner. Only those
 * refusals are caught: any other error, a failed audit write included,
 * propagates as a 500 and withPlatformAdmin rolls the removal back.
 *
 * ORPHAN PATH (review #1405 round 7, the one named exception in tests/unit/ci/adminUserAuditTargetCensus.test.ts):
 * when no users row exists for the id (findStoredUser), a membership stored under exactly that id is still removed,
 * since it is lingering access if the identity comes back, and audited under that id with { orphan: true }. A 404
 * only when neither exists. company-role does not do this: re-roling a user that does not exist makes no sense.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { AdminUuid, adminUserId } from '@/modules/admin/middleware/adminRequestErrors';
import { findStoredUser } from '@/modules/admin/services/storedUserId';
import { apiResponse } from '@/lib/apiResponse';
import {
  removeUserFromCompany, removeOrphanMembership, CompanyMembershipError, MEMBERSHIP_ERROR_CODE,
} from '@/modules/admin/services/companyMembershipService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const DeleteBody = z.object({
  company_id: AdminUuid,
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const requestedId = adminUserId(req.query.id);

  if (req.method === 'DELETE') {
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'company_id must be a valid UUID');
    }
    const { company_id } = parsed.data;

    // No users row: the orphan path. It returns false (nothing done) when a user was created meanwhile.
    if (!(await findStoredUser(requestedId)) && (await removeOrphan(req, res, requestedId, company_id))) return;
    // The stored id: acted on and audited exactly (read again: the orphan path may have found a new user).
    const user = await findStoredUser(requestedId);
    if (!user) return apiResponse.notFound(res, 'User');
    const userId = user.id;

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

/**
 * The orphan path (see the header): no users row, a membership under exactly `orphanUserId`. True when it answered;
 * false when a users row appeared meanwhile (nothing removed): the caller then takes the normal path.
 */
async function removeOrphan(
  req: AuthenticatedNextApiRequest, res: NextApiResponse, orphanUserId: string, companyId: string,
): Promise<boolean> {
  let removed: Awaited<ReturnType<typeof removeOrphanMembership>>;
  try {
    removed = await removeOrphanMembership(orphanUserId, companyId);
  } catch (err) {
    if (err instanceof CompanyMembershipError) {
      apiResponse.error(res, MEMBERSHIP_ERROR_CODE[err.code], err.message);
      return true;
    }
    throw err;
  }
  if (removed === 'user_exists') return false;
  if (!removed) {
    apiResponse.notFound(res, 'User');
    return true;
  }
  await logAdminAction(req.user.id, 'user.remove_from_company', 'user', orphanUserId,
    { company_id: companyId, previous_role: removed.previousRole, orphan: true }, getIp(req));
  apiResponse.success(res, { removed: true, orphan: true });
  return true;
}

export default withAdmin(withCsrf(handler));
