/**
 * Practice Client Groups API
 * GET  /api/accounting/practice/client-groups - List client groups
 * POST /api/accounting/practice/client-groups - Create a client group
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listClientGroups,
  createClientGroup,
} from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    return apiResponse.success(res, await listClientGroups(companyId));
  }

  if (req.method === 'POST') {
    const { name, description } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    return apiResponse.created(res, await createClientGroup(companyId, { name, description }));
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
