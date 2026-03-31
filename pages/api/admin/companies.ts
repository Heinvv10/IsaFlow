/**
 * Admin Companies List API
 * GET /api/admin/companies — List all companies across the platform
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listCompanies } from '@/modules/admin/services/adminCompanyService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const {
        search,
        status,
        plan,
        page,
        limit,
        sort_by,
        sort_dir,
      } = req.query;

      const result = await listCompanies({
        search: search as string | undefined,
        status: status as string | undefined,
        plan: plan as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        sort_by: sort_by as string | undefined,
        sort_dir: sort_dir as 'asc' | 'desc' | undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list companies', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list companies');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
