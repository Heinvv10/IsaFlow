/**
 * Asset Disposals API — GET: list disposals.
 *
 * There is deliberately NO POST here. This endpoint used to accept one, and it
 * inserted an asset_disposals row and set the asset to 'disposed' WITHOUT
 * posting anything to the general ledger — so the asset register and the GL
 * disagreed by the asset's book value, with nothing on either side saying so.
 * It also took no row lock and did not refuse an already-disposed asset, so
 * two concurrent requests could retire the same asset twice.
 *
 * Disposals go through POST /api/accounting/assets/:assetId/dispose, which
 * takes the lock, guards the status, runs the policy and tax calculation, and
 * posts the journal. Do not reintroduce a second disposal path here.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { parsePagination } from '@/lib/pagination';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as unknown as CompanyAuthedRequest).companyId;

  if (req.method === 'GET') {
    // P3.4: was an unbounded per-tenant list. One row per disposal event.
    const { limit, offset } = parsePagination(req.query, 500, 1000);
    const disposalsRaw = await sql`
      SELECT d.*, a.asset_number, a.name as asset_name, a.category
      FROM asset_disposals d
      JOIN assets a ON d.asset_id = a.id
      WHERE a.company_id = ${companyId}
      ORDER BY d.disposal_date DESC, d.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    ` as Row[];
    const hasMore = disposalsRaw.length > limit;
    const disposals = hasMore ? disposalsRaw.slice(0, limit) : disposalsRaw;
    return apiResponse.success(res, disposals, undefined, 200, { limit, offset, hasMore });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
