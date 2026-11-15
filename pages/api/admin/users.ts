/**
 * Admin Users List API
 * GET /api/admin/users — List all users across the platform
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminOptionalUuid, adminPaging } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { listUsers } from '@/modules/admin/services/adminUserService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const {
      search,
      role,
      company_id,
      company,
      status,
      page,
      limit,
    } = req.query;

    const result = await listUsers({
      search: search as string | undefined,
      role: role as string | undefined,
      company_id: adminOptionalUuid(company_id, 'company_id'),
      company: company as string | undefined,
      status: status as string | undefined,
      ...adminPaging({ page, limit }),
    });

    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
