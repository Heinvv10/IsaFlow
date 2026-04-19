/**
 * Practice Job Categories API
 * GET  /api/accounting/practice/job-categories  - List job categories
 * POST /api/accounting/practice/job-categories  - Create a job category
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listJobCategories,
  createJobCategory,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { includeInactive } = req.query;
    const result = await listJobCategories(companyId, includeInactive === 'true');
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const { name, sortOrder, reportingTag } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const category = await createJobCategory(companyId, { name, sortOrder, reportingTag });
    return apiResponse.created(res, category);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
