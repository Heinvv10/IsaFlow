/**
 * GET /api/accounting/reports-budget-comparator?period_start=&period_end=
 *
 * The budget column for the statement grid. Wraps getBudgetVariance, which
 * aggregates posted journal lines per account rather than reading the income
 * statement — see that service's header for why.
 *
 * `lines` is budgeted accounts followed by unbudgeted ones, because the
 * statement needs to look an account up by code regardless of which half it
 * fell into, and dropping the unbudgeted half would silently hide accounts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';

const Query = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkReportRateLimit(companyId, 'reports-budget-comparator'))) {
    log.warn('Budget comparator rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const { period_start: start, period_end: end } = parsed.data;
  const result = await getBudgetVariance(companyId, start, end);

  return apiResponse.success(res, {
    fiscalYear: result.fiscalYear,
    monthKeys: result.monthKeys,
    lines: [...result.rows, ...result.unbudgeted],
    postedThrough: result.postedThrough,
  });
}

export default withAuth(withErrorHandler(handler as never));
