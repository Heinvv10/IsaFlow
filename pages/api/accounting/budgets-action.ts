/**
 * Budget Action API
 * POST — delete an account's budget for a year ({glAccountId, fiscalYear}) or
 *        copy a year's budgets onto another by month position ({fromYear, toYear})
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { BudgetInputError, deleteBudget, copyBudgets } from '@/modules/accounting/services/core/budgetService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { action, glAccountId, fiscalYear, fromYear, toYear } = req.body;

  try {
    switch (action) {
      case 'delete':
        if (!glAccountId || !fiscalYear) return apiResponse.badRequest(res, 'glAccountId and fiscalYear required');
        await deleteBudget(companyId, glAccountId, Number(fiscalYear));
        return apiResponse.success(res, { deleted: true });
      case 'copy': {
        if (!fromYear || !toYear) return apiResponse.badRequest(res, 'fromYear and toYear required');
        const count = await copyBudgets(companyId, Number(fromYear), Number(toYear), userId);
        return apiResponse.success(res, { copied: count });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Budget action failed', { action, error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, err instanceof BudgetInputError ? err.message : 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
