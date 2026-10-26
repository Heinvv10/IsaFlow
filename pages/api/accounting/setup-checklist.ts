/**
 * GET /api/accounting/setup-checklist
 * Per-module setup progress (Sales, Purchases, Banking, Payroll, Tax) for the Home checklist.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getSetupProgress } from '@/modules/accounting/services/core/setupProgressService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  return apiResponse.success(res, await getSetupProgress(companyId));
}

export default withAuth(withErrorHandler(handler as any));
