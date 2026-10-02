/**
 * Engagement Budgets Report
 * GET /api/accounting/practice/reports/engagement-budgets?practiceClientId=...&jobId=...
 *
 * Per job: Engagement Budget, consumed (all non-leave time at hours × rate),
 * balance, hours used vs budgeted, % and state — over-budget first. The time
 * entry form reads it with `practiceClientId` to list a client's jobs with
 * their balances.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { listJobBudgetStatuses } from '@/modules/accounting/services/practice/practiceJobBudgetService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { practiceClientId, jobId } = req.query;
  // The ids reach a ::UUID cast on a read with no savepoint: refuse a malformed one here.
  if (practiceClientId !== undefined && !isUuidParam(practiceClientId)) {
    return apiResponse.badRequest(res, 'practiceClientId must be a UUID');
  }
  if (jobId !== undefined && !isUuidParam(jobId)) return apiResponse.badRequest(res, 'jobId must be a UUID');
  const rows = await listJobBudgetStatuses(companyId, { practiceClientId, jobId });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
