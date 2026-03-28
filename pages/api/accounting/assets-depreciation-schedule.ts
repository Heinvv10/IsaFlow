/**
 * Asset Depreciation Schedule API
 * GET: depreciation history for an asset or all assets
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { assetId, from, to } = req.query;

  if (assetId) {
    const schedule = await sql`
      SELECT ds.*, a.asset_number, a.name as asset_name
      FROM asset_depreciation_schedule ds
      JOIN assets a ON ds.asset_id = a.id
      WHERE ds.asset_id = ${String(assetId)}
      ORDER BY ds.period_date
    ` as Row[];
    return apiResponse.success(res, schedule);
  }

  const fromDate = from ? String(from) : '1900-01-01';
  const toDate = to ? String(to) : '2099-12-31';

  const schedule = await sql`
    SELECT ds.*, a.asset_number, a.name as asset_name, a.category
    FROM asset_depreciation_schedule ds
    JOIN assets a ON ds.asset_id = a.id
    WHERE ds.period_date BETWEEN ${fromDate} AND ${toDate}
    ORDER BY ds.period_date, a.asset_number
  ` as Row[];

  return apiResponse.success(res, schedule);
}

export default withCompany(withErrorHandler(handler as any));
