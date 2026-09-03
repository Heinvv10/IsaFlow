/**
 * Asset Register Report API
 * GET: full asset register with depreciation details
 *
 * The register and its totals come from
 * `items/assetRegisterService#getAssetRegister`, which the MCP `asset_register`
 * tool also calls. One figure, one query: a second implementation here would be
 * free to disagree with the one an agent reads.
 *
 * BEHAVIOUR CHANGE ON EXTRACTION: an asset disposed on or before `asOf` is no
 * longer counted as carrying amount. This route previously filtered on
 * purchase date alone, so a computer sold in April still reported its full book
 * value in August. Disposed assets are returned in their own field rather than
 * dropped.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { parsePagination } from '@/lib/pagination';
import { fmtDate } from '@/lib/fmtDate';
import {
  getAssetRegister,
  type AssetRegisterRow,
} from '@/modules/accounting/services/items/assetRegisterService';

/** The wire shape this route has always returned. Kept so the page keeps working. */
function toLegacyRow(a: AssetRegisterRow) {
  return {
    id: a.id,
    asset_number: a.assetNumber,
    name: a.name,
    category: a.category,
    category_name: a.categoryName,
    status: a.status,
    purchase_date: a.purchaseDate,
    purchase_price: a.purchasePrice,
    total_depreciation: a.accumulatedDepreciation,
    net_book_value: a.netBookValue,
    disposal_date: a.disposalDate,
    disposal_amount: a.disposalAmount,
  };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const companyId = (req as CompanyAuthedRequest).companyId;
  const { asOf } = req.query;
  const asOfDate = asOf ? String(asOf) : fmtDate(new Date());
  // P3.4: the register listed every asset unbounded. Summary totals come from a
  // SQL aggregate over the FULL population (correct regardless of the page),
  // while the row list itself is capped.
  const { limit, offset } = parsePagination(req.query, 1000, 2000);

  const page = await getAssetRegister(companyId, asOfDate, { limit, offset });

  const summary = {
    totalAssets: page.rowsTotal,
    totalCost: page.totals.cost,
    totalAccumulatedDepreciation: page.totals.accumulatedDepreciation,
    totalBookValue: page.totals.netBookValue,
    asOfDate,
  };

  return apiResponse.success(
    res,
    {
      assets: page.rows.map(toLegacyRow),
      disposed: page.disposed.map(toLegacyRow),
      summary,
    },
    undefined,
    200,
    { limit, offset, hasMore: page.hasMore },
  );
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
