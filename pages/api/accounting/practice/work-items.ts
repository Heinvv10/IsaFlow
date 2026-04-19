/**
 * Practice Work Items API
 * GET  /api/accounting/practice/work-items  - List work items
 * POST /api/accounting/practice/work-items  - Create a work item
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listWorkItems,
  createWorkItem,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { categoryId, includeInactive } = req.query;
    const result = await listWorkItems(
      companyId,
      categoryId as string | undefined,
      includeInactive === 'true',
    );
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const { categoryId, name, sortOrder, defaultBillable, defaultRateOverride } = req.body;
    if (!categoryId) return apiResponse.badRequest(res, 'categoryId is required');
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const item = await createWorkItem(companyId, categoryId as string, {
      name,
      sortOrder,
      defaultBillable,
      defaultRateOverride,
    });
    return apiResponse.created(res, item);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
