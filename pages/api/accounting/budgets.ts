/**
 * Budget Management API
 * GET  — list budgets for a fiscal year
 * POST — upsert a budget entry
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { getBudgets, upsertBudget } from '@/modules/accounting/services/core/budgetService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const fiscalYear = Number(req.query.fiscal_year) || new Date().getFullYear();
    const items = await getBudgets(companyId, fiscalYear);
    return apiResponse.success(res, { items, fiscalYear });
  }

  if (req.method === 'POST') {
    const { glAccountId, fiscalYear, annualAmount, months, notes } = req.body;
    if (!glAccountId || !fiscalYear || annualAmount == null) {
      return apiResponse.badRequest(res, 'glAccountId, fiscalYear, and annualAmount are required');
    }
    try {
      const entry = await upsertBudget(companyId, {
        glAccountId, fiscalYear: Number(fiscalYear),
        annualAmount: Number(annualAmount),
        months: months || undefined, notes,
      }, userId);
      return apiResponse.success(res, entry);
    } catch (err) {
      log.error('Failed to upsert budget', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
