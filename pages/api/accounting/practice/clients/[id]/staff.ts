/**
 * Practice Client Staff API
 * GET /api/accounting/practice/clients/[id]/staff – list company users for dropdown
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { listCompanyStaff } from '@/modules/accounting/services/practice/practiceClientRateOverrideService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const staff = await listCompanyStaff(companyId);
  return apiResponse.success(res, staff);
}

export default withAuth(withErrorHandler(handler));
