/**
 * Practice Staff Rate Detail API
 * PUT /api/accounting/practice/staff-rates/[id]  - Update a staff rate
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { updateStaffRate } from '@/modules/accounting/services/practice/practiceStaffRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (req.method === 'PUT') {
    const updated = await updateStaffRate(companyId, id as string, req.body);
    return apiResponse.success(res, updated);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
