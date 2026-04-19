/**
 * Practice Job Category Detail API
 * PUT    /api/accounting/practice/job-categories/[id]  - Update a job category
 * DELETE /api/accounting/practice/job-categories/[id]  - Delete a job category
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  updateJobCategory,
  deleteJobCategory,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (req.method === 'PUT') {
    const updated = await updateJobCategory(companyId, id as string, req.body);
    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    await deleteJobCategory(companyId, id as string);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
