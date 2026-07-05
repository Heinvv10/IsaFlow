/**
 * Asset Disposals API
 * GET: list disposals, POST: create disposal
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateDisposal } from '@/modules/accounting/services/items/assetService';
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
      ORDER BY d.disposal_date DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    ` as Row[];
    const hasMore = disposalsRaw.length > limit;
    const disposals = hasMore ? disposalsRaw.slice(0, limit) : disposalsRaw;
    return apiResponse.success(res, disposals, undefined, 200, { limit, offset, hasMore });
  }

  if (req.method === 'POST') {
    const body = req.body;
    const validation = validateDisposal(body);
    if (!validation.success) {
      return apiResponse.validationError(res,
        Object.fromEntries((validation.errors || []).map(e => [e.field, e.message]))
      );
    }

    const assets = await sql`
      SELECT id, current_book_value, status FROM assets WHERE id = ${body.assetId} AND company_id = ${companyId}
    ` as Row[];
    if (!assets[0]) return apiResponse.notFound(res, 'Asset', body.assetId);

    const bookValue = Number(assets[0].current_book_value);
    const gainLoss = (body.disposalAmount || 0) - bookValue;

    const disposal = await sql`
      INSERT INTO asset_disposals (
        asset_id, disposal_date, disposal_method, disposal_amount,
        book_value_at_disposal, gain_loss, reason, created_by
      ) VALUES (
        ${body.assetId}, ${body.disposalDate}, ${body.disposalMethod},
        ${body.disposalAmount || 0}, ${bookValue}, ${gainLoss},
        ${body.reason}, ${String(req.user.id)}
      ) RETURNING *
    ` as Row[];

    await sql`
      UPDATE assets SET
        status = 'disposed', disposal_date = ${body.disposalDate},
        disposal_method = ${body.disposalMethod}, disposal_amount = ${body.disposalAmount || 0},
        disposal_reason = ${body.reason}, disposal_gain_loss = ${gainLoss},
        updated_at = NOW()
      WHERE id = ${body.assetId} AND company_id = ${companyId}
    `;

    log.info('Asset disposed', { assetId: body.assetId, method: body.disposalMethod, gainLoss }, 'accounting');
    return apiResponse.created(res, disposal[0]);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
