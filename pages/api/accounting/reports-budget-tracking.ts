/**
 * GET /api/accounting/reports-budget-tracking (budgets P3 spec §4)
 *   period=month|quarter|ytd|fy|custom (default ytd)
 *   month=YYYY-MM | fiscal_year=<label> [&quarter=1..5] | from=YYYY-MM&to=YYYY-MM
 *   version_id, cc1_id, cc2_id, bu_id (uuid)   group_by=cc1|cc2|bu (bullets)
 *
 * Budget vs Actual on the tracking engine: income-statement bands, Actual /
 * Budget / Var R / Var %, Projected FY, the dimension filter and its
 * unallocated budget. Read-only, like the income statement: viewer roles may
 * open it (contract decision 15), so no withWriteAccess.
 *
 * 400 a malformed value, a quarter past the year, from > to, > 24 months, a
 * version from another year; 404 a year label, version or dimension id that
 * is not this company's. The company is the authenticated request's.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT, reportRateLimitRetryAfter } from '@/lib/rateLimit';
import { respondTrackingError } from '@/lib/budgetTrackingResponse';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { parseTrackingQuery } from '@/modules/accounting/services/budgets/tracking/trackingQuery';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkReportRateLimit(companyId, 'reports-budget-tracking', { ...INTERACTIVE_REPORT_LIMIT }))) {
    log.warn('Budget tracking rate limit exceeded', { companyId }, 'rateLimit');
    const secs = await reportRateLimitRetryAfter(companyId, 'reports-budget-tracking', INTERACTIVE_REPORT_LIMIT.windowSecs);
    res.setHeader('Retry-After', String(secs));
    const wait = secs < 60 ? `${secs} second${secs === 1 ? '' : 's'}` : `${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) === 1 ? '' : 's'}`;
    return apiResponse.tooManyRequests(res, `Too many report requests: try again in ${wait}.`);
  }

  const parsed = parseTrackingQuery(req.query);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.message, parsed.fieldErrors);

  try {
    return apiResponse.success(res, await buildBudgetTrackingReport(companyId, parsed.params));
  } catch (err) {
    if (respondTrackingError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler as never));
