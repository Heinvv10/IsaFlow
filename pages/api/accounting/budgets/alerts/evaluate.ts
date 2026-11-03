/**
 * "Evaluate now" (budgets P5 spec §3d/§4): POST → runs the overspend evaluation for the session's
 * company as of today (SAST), in this request's transaction (app_user under RLS): new crossings are
 * written and announced in the bell of every owner and admin, recovered ones resolve, and "last
 * evaluated" is recorded. No email (the digest is the daily run's). Owner or admin only, CSRF,
 * 10 runs per 10 minutes per company (429 with Retry-After). 503 while another evaluation of the
 * company holds its lock past the bounded wait.
 * → { fiscalYear, keys, fired, resolved, lastEvaluated }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit } from '@/lib/rateLimit';
import { BUDGET_CONTROL_ADMIN_ROLES, respondBudgetControlsError } from '@/lib/budgetControlsResponse';
import { evaluateNow } from '@/modules/accounting/services/budgets/budgetControlsApi';

const EVALUATE_LIMIT = { max: 10, windowSecs: 600 } as const;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  if (!(await checkRateLimit(`budget-alerts-evaluate:${companyId}`, EVALUATE_LIMIT))) {
    res.setHeader('Retry-After', String(EVALUATE_LIMIT.windowSecs));
    return apiResponse.tooManyRequests(res, 'Budget alerts were evaluated several times just now; wait a few minutes and try again.');
  }
  try {
    return apiResponse.success(res, await evaluateNow(companyId));
  } catch (err) {
    if (respondBudgetControlsError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: BUDGET_CONTROL_ADMIN_ROLES }))));
