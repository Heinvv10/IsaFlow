/**
 * Admin Add User To Company API
 * POST /api/admin/users/[id]/add-to-company — Add a user to a company with a given role
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { addUserToCompany } from '@/modules/admin/services/adminUserService';
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
      const { company_id, role } = req.body as {
        company_id?: string;
        role?: string;
      };

      if (!company_id || !role) {
        return apiResponse.badRequest(res, 'company_id and role are required');
      }

      await addUserToCompany(userId, company_id, role);

      await logAdminAction(
        req.user.id,
        'user.add_to_company',
        'user',
        userId,
        { company_id, role },
        getIp(req)
      );

      return apiResponse.success(res, { added: true });
    } catch (err) {
      log.error('Failed to add user to company', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to add user to company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
