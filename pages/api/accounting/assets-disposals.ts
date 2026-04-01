/**
 * Asset Disposals API
 * GET: list disposals, POST: create disposal
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateDisposal } from '@/modules/accounting/services/assetService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const disposals = await sql`
      SELECT d.*, a.asset_number, a.name as asset_name, a.category
      FROM asset_disposals d
      JOIN assets a ON d.asset_id = a.id
      ORDER BY d.disposal_date DESC
    ` as Row[];
    return apiResponse.success(res, disposals);
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
      SELECT id, current_book_value, status FROM assets WHERE id = ${body.assetId}
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
      WHERE id = ${body.assetId}
    `;

    log.info('Asset disposed', { assetId: body.assetId, method: body.disposalMethod, gainLoss }, 'accounting');
    return apiResponse.created(res, disposal[0]);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler));
