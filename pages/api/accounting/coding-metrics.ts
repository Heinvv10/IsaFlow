/**
 * GET /api/accounting/coding-metrics?month=YYYY-MM
 *
 * The active company's learning-loop coding metrics for a month (default: the current SA month):
 * auto-coded % (no clicks), suggestions accepted %, first-30-days acceptance and the re-code rate on
 * auto-posted lines. Definitions: src/modules/accounting/services/bank/codingMetrics.ts.
 *
 * Auth: withAuth. The company is req.companyId only (membership-checked by withAuth); no company id is
 * read from the request.
 */
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  computeCodingMetrics, currentSaMonth, monthPeriod, MIN_DECISIONS_FOR_RATE,
} from '@/modules/accounting/services/bank/codingMetrics';
import { loadCodingCounts } from '@/modules/accounting/services/bank/codingMetricsService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : currentSaMonth();
  const period = monthPeriod(month);
  if (!period) return apiResponse.badRequest(res, 'month must be YYYY-MM');

  const [counts] = await loadCodingCounts([req.companyId], period);
  return apiResponse.success(res, {
    period,
    minDecisions: MIN_DECISIONS_FOR_RATE,
    metrics: computeCodingMetrics(counts!),
  });
}

export default withAuth(withErrorHandler(handler));
