/**
 * Budget Management API
 * GET  — list budgets for a financial year (label), with the year's months
 *        and the years a budget can be set for
 * POST — upsert a budget entry: `months` ([{month:'YYYY-MM', amount}], exactly
 *        the year's months) or `annualAmount` (spread evenly over them)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { BudgetInputError, getBudgets, upsertBudget, type BudgetMonthAmount } from '@/modules/accounting/services/core/budgetService';
import { listBudgetYears, toBudgetYearInfo } from '@/modules/accounting/services/core/budgetYears';
import { fiscalYearForDate, requireFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { localISODate } from '@/lib/dateUtils';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const today = localISODate();
    const requested = Number(req.query.fiscal_year);
    try {
      const fiscalYear = Number.isInteger(requested) && requested > 0
        ? requested
        : (await fiscalYearForDate(companyId, today)).fiscalYear;
      const year = toBudgetYearInfo(await requireFiscalYear(companyId, fiscalYear));
      const [items, years] = await Promise.all([getBudgets(companyId, fiscalYear), listBudgetYears(companyId, today)]);
      return apiResponse.success(res, { items, fiscalYear, year, monthKeys: year.monthKeys, years });
    } catch (err) {
      log.error('Failed to load budgets', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Could not load budgets');
    }
  }

  if (req.method === 'POST') {
    const { glAccountId, fiscalYear, annualAmount, months, notes } = req.body;
    if (!glAccountId || !fiscalYear || (annualAmount == null && !Array.isArray(months))) {
      return apiResponse.badRequest(res, 'glAccountId, fiscalYear, and months or annualAmount are required');
    }
    try {
      const entry = await upsertBudget(companyId, {
        glAccountId, fiscalYear: Number(fiscalYear),
        annualAmount: annualAmount == null ? undefined : Number(annualAmount),
        months: Array.isArray(months) ? (months as BudgetMonthAmount[]) : undefined, notes,
      }, userId);
      return apiResponse.success(res, entry);
    } catch (err) {
      log.error('Failed to upsert budget', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, err instanceof BudgetInputError ? err.message : 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
