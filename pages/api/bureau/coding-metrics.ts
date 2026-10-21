/**
 * GET /api/bureau/coding-metrics?bureauId=...&month=YYYY-MM
 *
 * Learning-loop coding metrics for every client of a bureau, plus the bureau total.
 *
 * Auth: withUserAuth + bureau_users membership (the bureau pattern; no company context). Any member sees
 * the per-client numbers; only owner and accountant see the bureau-level total (`total` is null for a
 * viewer). The company set is the bureau's bureau_companies, never taken from the request.
 * The total pools counts across clients (line- / decision-weighted), see codingMetrics.ts.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { UUID } from '@/lib/schemas/common';
import { listBureauCompanies } from '@/modules/bureau/services/bureauService';
import { getBureauRole } from '@/modules/bureau/services/bureauService';
import {
  aggregateCodingMetrics, computeCodingMetrics, currentSaMonth, monthPeriod, MIN_DECISIONS_FOR_RATE,
} from '@/modules/accounting/services/bank/codingMetrics';
import { loadCodingCounts } from '@/modules/accounting/services/bank/codingMetricsService';

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const bureauId = UUID.safeParse(req.query.bureauId);
  if (!bureauId.success) return apiResponse.badRequest(res, 'bureauId is required');
  const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : currentSaMonth();
  const period = monthPeriod(month);
  if (!period) return apiResponse.badRequest(res, 'month must be YYYY-MM');

  const role = await getBureauRole(req.user.id, bureauId.data);
  if (!role) return apiResponse.forbidden(res, 'Not a member of this bureau');

  const clients = await listBureauCompanies(bureauId.data);
  const counts = await loadCodingCounts(clients.map((c) => c.companyId), period);
  const name = new Map(clients.map((c) => [c.companyId, c.companyName]));
  return apiResponse.success(res, {
    bureauId: bureauId.data,
    role,
    period,
    minDecisions: MIN_DECISIONS_FOR_RATE,
    weighting: 'pooled',
    clients: counts.map((c) => ({ companyId: c.companyId, companyName: name.get(c.companyId) ?? '', metrics: computeCodingMetrics(c) })),
    total: role === 'viewer' ? null : aggregateCodingMetrics(counts),
  });
}

export default withUserAuth(withErrorHandler(handler));
