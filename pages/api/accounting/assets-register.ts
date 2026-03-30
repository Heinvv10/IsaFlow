/**
 * Asset Register Report API
 * GET: full asset register with depreciation details
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

  const companyId = (req as any).companyId as string;
  const { asOf } = req.query;
  const asOfDate = asOf ? String(asOf) : new Date().toISOString().split('T')[0];

  const rows = await sql`
    SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years,
      COALESCE(a.accumulated_depreciation, 0) as total_depreciation,
      COALESCE(a.current_book_value, a.purchase_price) as net_book_value
    FROM assets a
    LEFT JOIN asset_categories ac ON a.category_id = ac.id
    WHERE a.purchase_date <= ${asOfDate} AND a.company_id = ${companyId}::UUID
    ORDER BY a.category, a.asset_number
  ` as Row[];

  const summary = {
    totalAssets: rows.length,
    totalCost: rows.reduce((s, r) => s + Number(r.purchase_price || 0), 0),
    totalAccumulatedDepreciation: rows.reduce((s, r) => s + Number(r.total_depreciation || 0), 0),
    totalBookValue: rows.reduce((s, r) => s + Number(r.net_book_value || 0), 0),
    asOfDate,
  };

  return apiResponse.success(res, { assets: rows, summary });
}

export default withCompany(withErrorHandler(handler as any));
