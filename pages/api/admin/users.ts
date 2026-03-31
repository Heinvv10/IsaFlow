/**
 * Admin Users List API
 * GET /api/admin/users — List all users across the platform
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
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

export default withAdmin(handler);
