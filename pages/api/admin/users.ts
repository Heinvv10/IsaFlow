/**
 * Admin Users List API
 * GET /api/admin/users — List all users across the platform
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listUsers } from '@/modules/admin/services/adminUserService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const {
        search,
        role,
        company_id,
        status,
        page,
        limit,
      } = req.query;

      const result = await listUsers({
        search: search as string | undefined,
        role: role as string | undefined,
        company_id: company_id as string | undefined,
        status: status as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list users', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list users');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
