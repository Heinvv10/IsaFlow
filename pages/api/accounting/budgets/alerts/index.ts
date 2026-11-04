/**
 * The company's budget overspend alerts (budgets P5 spec §4/§5): GET → { open, resolved (last 30
 * days), lastEvaluated }. Owner or admin only (decision 9: alerts go to owners and admins).
 * Company from the session; every query names it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { BUDGET_CONTROL_ADMIN_ROLES } from '@/lib/budgetControlsResponse';
import { listBudgetAlerts } from '@/modules/accounting/services/budgets/budgetAlertList';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (!BUDGET_CONTROL_ADMIN_ROLES.includes(companyRole ?? '')) {
    return apiResponse.forbidden(res, 'Only an owner or admin can see budget alerts.');
  }
  return apiResponse.success(res, await listBudgetAlerts(companyId));
}

export default withAuth(withErrorHandler(handler));
