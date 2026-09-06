/**
 * GET /api/accounting/reports-account-trends?as_of=YYYY-MM-DD&basis=movement|balance
 *
 * Twelve monthly figures per account code, for the statement trend column
 * and the small-multiples panel. `movement` for P&L accounts, `balance` for
 * balance-sheet accounts — see trendRowsService for why they differ.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import {
  getMonthlyBalances, getMonthlyMovements,
} from '@/modules/accounting/services/reports/trendRowsService';

const Query = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basis: z.enum(['movement', 'balance']).default('movement'),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkReportRateLimit(companyId, 'reports-account-trends'))) {
    log.warn('Account trends rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const { as_of: asOf, basis } = parsed.data;
  const trends = basis === 'balance'
    ? await getMonthlyBalances(companyId, asOf)
    : await getMonthlyMovements(companyId, asOf);

  return apiResponse.success(res, trends);
}

export default withAuth(withErrorHandler(handler as never));
