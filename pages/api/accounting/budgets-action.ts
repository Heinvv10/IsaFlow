/**
 * Budget Action API
 * POST — delete budget or copy budgets between years
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { deleteBudget, copyBudgets } from '@/modules/accounting/services/budgetService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { action, id, fromYear, toYear } = req.body;

  try {
    switch (action) {
      case 'delete':
        if (!id) return apiResponse.badRequest(res, 'id required');
        await deleteBudget(companyId, id);
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
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Action failed');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
