/**
 * Admin Company Users API
 * GET /api/admin/companies/[id]/users — List users belonging to a company
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { getCompanyUsers } from '@/modules/admin/services/adminCompanyService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = adminUuid(req.query.id, 'company id');

  if (req.method === 'GET') {
    const users = await getCompanyUsers(companyId);
    return apiResponse.success(res, users);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
