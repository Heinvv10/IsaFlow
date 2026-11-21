/**
 * GET /api/accounting/dashboard/attention
 *
 * The dashboard's one "Needs attention" list for the active company:
 * { asAt, items }. Read only. A failed reader answers 500 (withErrorHandler),
 * so the screen shows Retry rather than an all-clear.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import type { UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { getAttentionList } from '@/modules/accounting/services/dashboard/attentionService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as UserAuthedRequest).user?.id;
  if (!companyId || !userId) return apiResponse.forbidden(res, 'Company context or user identity missing.');
  // Pay runs, the payroll cash shortfall and the payroll signals are listed only for a caller with Payroll read in this company.
  const payrollRead = await mayReadPayroll(companyId, userId);
  // census-exempt(getAttentionList): company-level headcount, status or payroll totals; no one person's pay (the aggregate-totals limit in the PR body)
  return apiResponse.success(res, await getAttentionList(companyId, { payrollRead }));
}

export default withAuth(withErrorHandler(handler));
