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
import { fiscalYearForDate, getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { localISODate } from '@/lib/dateUtils';

function isMonthAmount(m: unknown): m is BudgetMonthAmount {
  return typeof m === 'object' && m !== null && typeof (m as { month?: unknown }).month === 'string';
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const today = localISODate();
    const raw = req.query.fiscal_year;
    // The page's first load has no year yet: absent and empty both mean "the current year".
    const requested = raw === undefined || raw === '' ? null : Number(raw);
    if (requested !== null && !(Number.isInteger(requested) && requested > 0)) {
      return apiResponse.badRequest(res, 'fiscal_year must be a year label such as 2027');
    }
    const fiscalYear = requested ?? (await fiscalYearForDate(companyId, today)).fiscalYear;
    const found = await getFiscalYear(companyId, fiscalYear);
    if (!found) return apiResponse.notFound(res, 'Financial year', String(fiscalYear));
    // Anything else that fails is a real failure: withErrorHandler answers 500.
    const year = toBudgetYearInfo(found);
    // One after the other: both run savepoints on the one request connection, and
    // savepoints there must nest, never interleave (src/lib/neon/transaction.ts).
    const items = await getBudgets(companyId, fiscalYear);
    const years = await listBudgetYears(companyId, today);
    return apiResponse.success(res, { items, fiscalYear, year, monthKeys: year.monthKeys, years });
  }

  if (req.method === 'POST') {
    const { glAccountId, fiscalYear, annualAmount, months, notes } = req.body;
    if (!glAccountId || !fiscalYear || (annualAmount == null && !Array.isArray(months))) {
      return apiResponse.badRequest(res, 'glAccountId, fiscalYear, and months or annualAmount are required');
    }
    const label = Number(fiscalYear);
    if (!(Number.isInteger(label) && label > 0)) {
      return apiResponse.badRequest(res, 'fiscalYear must be a year label such as 2027');
    }
    if (Array.isArray(months) && !months.every(isMonthAmount)) {
      return apiResponse.badRequest(res, "Each entry in months must be { month: 'YYYY-MM', amount }");
    }
    try {
      const entry = await upsertBudget(companyId, {
        glAccountId, fiscalYear: label,
        annualAmount: annualAmount == null ? undefined : Number(annualAmount),
        months: Array.isArray(months) ? (months as BudgetMonthAmount[]) : undefined, notes,
      }, userId);
      return apiResponse.success(res, entry);
    } catch (err) {
      if (err instanceof BudgetInputError) return apiResponse.badRequest(res, err.message);
      if ((err as { code?: string }).code === '22003') {
        return apiResponse.badRequest(res, 'A budget amount is too large (at most 13 digits before the decimal point).');
      }
      log.error('Failed to upsert budget', { error: err }, 'accounting-api');
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
