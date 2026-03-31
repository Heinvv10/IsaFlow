/**
 * Admin Company Users API
 * GET /api/admin/companies/[id]/users — List users belonging to a company
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getCompanyUsers } from '@/modules/admin/services/adminCompanyService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const users = await getCompanyUsers(companyId);
      return apiResponse.success(res, users);
    } catch (err) {
      log.error('Failed to get company users', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get company users');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
