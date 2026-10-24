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
import { parseYearLabel } from '@/modules/accounting/services/core/budgetMonths';
import { isUuidParam } from '@/lib/validation';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { action, glAccountId, fiscalYear, fromYear, toYear } = req.body;

  try {
    switch (action) {
      case 'delete': {
        if (!glAccountId || !fiscalYear) return apiResponse.badRequest(res, 'glAccountId and fiscalYear required');
        if (!isUuidParam(glAccountId)) return apiResponse.badRequest(res, 'glAccountId must be an account id');
        const label = parseYearLabel(fiscalYear);
        if (label === null) return apiResponse.badRequest(res, 'fiscalYear must be a year label such as 2027');
        await deleteBudget(companyId, glAccountId, label);
        return apiResponse.success(res, { deleted: true });
      }
      case 'copy': {
        if (!fromYear || !toYear) return apiResponse.badRequest(res, 'fromYear and toYear required');
        const from = parseYearLabel(fromYear), to = parseYearLabel(toYear);
        if (from === null || to === null) return apiResponse.badRequest(res, 'fromYear and toYear must be year labels such as 2027');
        const count = await copyBudgets(companyId, from, to, userId);
        return apiResponse.success(res, { copied: count });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Budget action failed', { action, error: err }, 'accounting-api');
    // Only a refusal written for the caller is a 400; any other failure is a server error (withErrorHandler's 500).
    if (err instanceof BudgetInputError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
