/**
 * GET /api/accounting/setup-checklist
 * Per-module setup progress (Sales, Purchases, Banking, Payroll, Tax) for the Home checklist.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import type { UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { getSetupProgress } from '@/modules/accounting/services/core/setupProgressService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as UserAuthedRequest).user?.id;
  if (!companyId || !userId) return apiResponse.forbidden(res, 'Company context or user identity missing.');
  const payrollRead = await mayReadPayroll(companyId, userId);
  // census-exempt(getSetupProgress): company-level headcount, status or payroll totals; no one person's pay (the aggregate-totals limit in the PR body)
  return apiResponse.success(res, await getSetupProgress(companyId, { payrollRead }));
}

export default withAuth(withErrorHandler(handler as any));
