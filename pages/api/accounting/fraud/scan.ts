/** POST /api/accounting/fraud/scan — manually trigger a fraud scan for this company */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { scanCompanyForFraud } from '@/modules/accounting/services/capture/supplierGraphService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const { companyId } = req;
  const result = await scanCompanyForFraud(companyId);
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
