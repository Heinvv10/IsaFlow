/**
 * Practice Clients API
 * GET  /api/accounting/practice/clients  - List practice clients
 * POST /api/accounting/practice/clients  - Create a practice client
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listPracticeClients,
  createPracticeClient,
} from '@/modules/accounting/services/practice/practiceClientService';
import { seedDefaultCategories } from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { status, search, groupId, limit, offset } = req.query;
    const result = await listPracticeClients(companyId, {
      status: status as string | undefined,
      search: search as string | undefined,
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const {
      legalName,
      tradingName,
      registrationNo,
      taxNo,
      clientGroupId,
      assignedPartnerId,
      assignedManagerId,
      billingModel,
      status,
      linkCustomerId,
    } = req.body;

    if (!legalName) return apiResponse.badRequest(res, 'legalName is required');
    if (!billingModel) return apiResponse.badRequest(res, 'billingModel is required');
    if (!status) return apiResponse.badRequest(res, 'status is required');

    const client = await createPracticeClient(companyId, {
      legalName,
      tradingName,
      registrationNo,
      taxNo,
      clientGroupId,
      assignedPartnerId,
      assignedManagerId,
      billingModel,
      status,
      linkCustomerId,
    });
    await seedDefaultCategories(companyId);
    return apiResponse.created(res, client);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
