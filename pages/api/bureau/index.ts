/**
 * GET /api/bureau
 *
 * Returns the bureaus the current user belongs to + the cross-client work
 * aggregator. All aggregation SQL lives in bureauWorkAggregatorService.
 *
 * Auth: any logged-in user. account_type='direct' users get an empty payload;
 * the page redirects them away.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { listBureausForUser } from '@/modules/bureau/services/bureauService';
import {
  aggregateBureauWork,
  type CompanyMeta,
} from '@/modules/bureau/services/bureauWorkAggregatorService';
import { rollupClientTriage } from '@/modules/bureau/services/bureauClientTriageService';

function zeroStats() {
  return { overdue: 0, dueSoon: 0, info: 0, total: 0, monthEnd: { closed: 0, total: 0 } };
}

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const userId = req.user.id;
  const bureaus = await listBureausForUser(userId);
  if (bureaus.length === 0) {
    return apiResponse.success(res, { bureaus: [], workItems: [], stats: zeroStats() });
  }

  const bureauIds = bureaus.map((b) => b.id);
  const companyRows = (await sql`
    SELECT bc.bureau_id, b.name AS bureau_name, bc.company_id, c.name AS company_name
      FROM bureau_companies bc
      JOIN bureaus b ON b.id = bc.bureau_id
      JOIN companies c ON c.id = bc.company_id
     WHERE bc.bureau_id = ANY(${bureauIds})
     ORDER BY b.name, c.name
  `) as unknown as CompanyMeta[];

  if (companyRows.length === 0) {
    return apiResponse.success(res, { bureaus, workItems: [], stats: zeroStats(), companyCount: 0, clientTriage: [] });
  }

  const companyIds = companyRows.map((r) => r.company_id);
  const meta = new Map<string, CompanyMeta>(companyRows.map((r) => [r.company_id, r]));

  const { items, monthEnd } = await aggregateBureauWork(companyIds, meta, new Date());

  const stats = {
    overdue: items.filter((i) => i.severity === 'overdue').length,
    dueSoon: items.filter((i) => i.severity === 'due_soon').length,
    info: items.filter((i) => i.severity === 'info').length,
    total: items.length,
    monthEnd,
  };

  const clientTriage = rollupClientTriage(items, companyRows);

  return apiResponse.success(res, { bureaus, workItems: items, stats, companyCount: companyRows.length, clientTriage });
}

export default withUserAuth(withErrorHandler(handler));
