/**
 * GET /api/home
 *
 * Level-2 client-home payload for a DIRECT client: { metrics, workItems,
 * cashPosition } for the caller's active company. Auth: withAuth — the active
 * company's company_users membership IS the ownership gate (no URL-supplied id,
 * RLS GUC set). Reuses the bureau metrics + work-aggregator services scoped to
 * the one verified company; the synthetic CompanyMeta has empty bureau labels
 * (the feed SQL is company_id-only and the single-company home ignores the
 * labels).
 *
 * Notes for consumers:
 * - Returned workItems carry empty-string bureauId/bureauName (synthetic
 *   single-company meta) — direct-client consumers must NOT rely on those labels.
 * - This payload intentionally omits the bureau endpoint's `company` field; the
 *   direct consumer reads its own company identity from session/CompanyContext.
 * - `cashPosition` is an advisory estimate (fail-soft per section): each section
 *   degrades to null/empty independently so a broken estimate never blocks the page.
 */
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import {
  aggregateBureauWork,
  type CompanyMeta,
} from '@/modules/bureau/services/bureauWorkAggregatorService';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req;

  // companyId ownership is verified by withAuth (company_users membership check) —
  // the stronger equivalent of the bureau path's getBureauClientForUser pre-check.
  const now = new Date();
  const [metrics, work] = await Promise.all([
    clientMetricsSnapshot(companyId),
    aggregateBureauWork(
      [companyId],
      new Map<string, CompanyMeta>([
        [companyId, { bureau_id: '', bureau_name: '', company_id: companyId, company_name: '' }],
      ]),
      now,
    ),
  ]);
  const cashPosition = await getOwnerCashPosition(companyId, metrics.cash, now);

  return apiResponse.success(res, { metrics, workItems: work.items, cashPosition });
}

export default withAuth(withErrorHandler(handler as never));
