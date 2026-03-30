/**
 * Admin Remove User From Company API
 * DELETE /api/admin/users/[id]/remove-from-company — Remove a user from a company
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { removeUserFromCompany } from '@/modules/admin/services/adminUserService';
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

  if (req.method === 'DELETE') {
    try {
      const { company_id } = req.body as { company_id?: string };

      if (!company_id) {
        return apiResponse.badRequest(res, 'company_id is required');
      }

      await removeUserFromCompany(userId, company_id);

      await logAdminAction(
        req.user.id,
        'user.remove_from_company',
        'user',
        userId,
        { company_id },
        getIp(req)
      );

      return apiResponse.success(res, { removed: true });
    } catch (err) {
      log.error('Failed to remove user from company', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to remove user from company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
