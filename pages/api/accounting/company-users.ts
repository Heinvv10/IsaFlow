/**
 * Company Users API
 * GET  — list users in the active company
 * PUT  — update a user's role { userId, role }  (owner/admin only)
 * DELETE — remove a user { userId }             (owner/admin only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { listCompanyUsers, updateCompanyUserRole, removeCompanyUser } from '@/modules/accounting/services/userAccessService';

const ADMIN_ROLES = ['owner', 'admin'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyApiRequest;
  const authReq = req as CompanyApiRequest;

  // GET — list all users
  if (req.method === 'GET') {
    const users = await listCompanyUsers(companyId);
    return apiResponse.success(res, users);
  }

  // PUT — update role (owner/admin only)
  if (req.method === 'PUT') {
    if (!ADMIN_ROLES.includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only owners and admins can change user roles.');
    }

    const { userId, role } = req.body as { userId?: string; role?: string };
    if (!userId || !role) {
      return apiResponse.badRequest(res, 'userId and role are required.');
    }

    try {
      await updateCompanyUserRole(companyId, userId, role);
      const users = await listCompanyUsers(companyId);
      return apiResponse.success(res, users);
    } catch (err) {
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Update failed.');
    }
  }

  // DELETE — remove user (owner/admin only, cannot remove self)
  if (req.method === 'DELETE') {
    if (!ADMIN_ROLES.includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only owners and admins can remove users.');
    }

    const { userId } = req.body as { userId?: string };
    if (!userId) {
      return apiResponse.badRequest(res, 'userId is required.');
    }

    const currentUserId = (authReq as unknown as { user: { id: string } }).user.id;
    if (userId === currentUserId) {
      return apiResponse.badRequest(res, 'You cannot remove yourself from the company.');
    }

    try {
      await removeCompanyUser(companyId, userId);
      const users = await listCompanyUsers(companyId);
      return apiResponse.success(res, users);
    } catch (err) {
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Remove failed.');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
