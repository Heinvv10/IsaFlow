/**
 * Asset Register Report API
 * GET: full asset register with depreciation details
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { parsePagination } from '@/lib/pagination';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const companyId = (req as CompanyAuthedRequest).companyId;
  const { asOf } = req.query;
  const asOfDate = asOf ? String(asOf) : new Date().toISOString().split('T')[0];
  // P3.4: the register listed every asset unbounded. Summary totals now come
  // from a SQL aggregate over the FULL population (correct regardless of the
  // page), while the row list itself is capped.
  const { limit, offset } = parsePagination(req.query, 1000, 2000);

  const rows = await sql`
    SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years,
      COALESCE(a.accumulated_depreciation, 0) as total_depreciation,
      COALESCE(a.current_book_value, a.purchase_price) as net_book_value
    FROM assets a
    LEFT JOIN asset_categories ac ON a.category_id = ac.id
    WHERE a.purchase_date <= ${asOfDate} AND a.company_id = ${companyId}::UUID
    ORDER BY a.category, a.asset_number
    LIMIT ${limit + 1} OFFSET ${offset}
  ` as Row[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const [totals] = await sql`
    SELECT COUNT(*)::int as total_assets,
      COALESCE(SUM(a.purchase_price::numeric), 0) as total_cost,
      COALESCE(SUM(COALESCE(a.accumulated_depreciation, 0)::numeric), 0) as total_depreciation,
      COALESCE(SUM(COALESCE(a.current_book_value, a.purchase_price)::numeric), 0) as total_book_value
    FROM assets a
    WHERE a.purchase_date <= ${asOfDate} AND a.company_id = ${companyId}::UUID
  ` as Row[];

  const summary = {
    totalAssets: Number(totals?.total_assets ?? 0),
    totalCost: Number(totals?.total_cost ?? 0),
    totalAccumulatedDepreciation: Number(totals?.total_depreciation ?? 0),
    totalBookValue: Number(totals?.total_book_value ?? 0),
    asOfDate,
  };

  return apiResponse.success(res, { assets: page, summary }, undefined, 200, { limit, offset, hasMore });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
