/**
 * GET /api/bureau/client/[companyId]
 *
 * Level 2 client home payload: { company, metrics, workItems }.
 * Auth: withUserAuth (user-scoped). The path companyId is NEVER trusted —
 * getBureauClientForUser re-derives entitlement and returns 404 for any id
 * not in the caller's bureau set. Both reads are scoped to that one verified id.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getBureauClientForUser } from '@/modules/bureau/services/bureauService';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import {
  aggregateBureauWork,
  type CompanyMeta,
} from '@/modules/bureau/services/bureauWorkAggregatorService';

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req.query;
  if (typeof companyId !== 'string' || companyId.length === 0) {
    return apiResponse.badRequest(res, 'companyId is required');
  }

  const meta = await getBureauClientForUser(req.user.id, companyId);
  if (!meta) {
    return apiResponse.notFound(res, 'Client');
  }

  const [metrics, work] = await Promise.all([
    clientMetricsSnapshot(companyId),
    aggregateBureauWork(
      [companyId],
      new Map<string, CompanyMeta>([[companyId, meta]]),
      new Date(),
    ),
  ]);

  return apiResponse.success(res, {
    company: { id: companyId, name: meta.company_name, bureauName: meta.bureau_name },
    metrics,
    workItems: work.items,
  });
}

export default withUserAuth(withErrorHandler(handler));
