/**
 * Budget grid prior-year actuals (budgets P2)
 * GET ?fiscal_year=2027&grain=company|cc1|cc2|bu — per account and budget-year month, the same
 * calendar month one year earlier (posted entries, natural sign), fetched lazily per view.
 * `grain` defaults to company. Any member may read; 60 reads a minute per user (429 with Retry-After).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { parseYearLabel } from '@/modules/accounting/services/core/budgetMonths';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { loadPriorActuals, PRIOR_GRAINS, type PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  // A whole year of posted movement per call: a page fetches it once per view, never 60 times a minute.
  if (!(await checkRateLimit(`budget-prior-actuals:${(req as AuthenticatedNextApiRequest).user.id}`, { max: 60, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many prior-year reads; wait a minute and try again.');
  }
  const label = parseYearLabel(req.query.fiscal_year);
  if (label === null) return apiResponse.badRequest(res, 'fiscal_year must be a year label such as 2027');
  const rawGrain = req.query.grain ?? 'company';
  if (typeof rawGrain !== 'string' || !(PRIOR_GRAINS as readonly string[]).includes(rawGrain)) {
    return apiResponse.badRequest(res, `grain must be one of ${PRIOR_GRAINS.join(', ')}`);
  }
  try {
    return apiResponse.success(res, await loadPriorActuals(companyId, label, rawGrain as PriorGrain));
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    if (err instanceof FiscalYearLabelUnknownError) return apiResponse.notFound(res, 'Financial year', String(err.fiscalYear));
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
