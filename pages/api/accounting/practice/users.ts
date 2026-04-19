/**
 * Practice Users API
 * GET — list users belonging to the current company (for dropdowns / display names)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { listCompanyUsers } from '@/modules/accounting/services/practice/practiceUsersService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const users = await listCompanyUsers(companyId);
  return apiResponse.success(res, users);
}

export default withAuth(withErrorHandler(handler));
