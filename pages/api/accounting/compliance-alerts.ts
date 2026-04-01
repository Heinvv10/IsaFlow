/**
 * Compliance Alerts API
 * GET /api/accounting/compliance-alerts
 * Returns statutory document compliance alerts for the company.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { checkComplianceAlerts } from '@/modules/accounting/services/statutoryDocService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const alerts = await checkComplianceAlerts(companyId);

  return apiResponse.success(res, { alerts });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
