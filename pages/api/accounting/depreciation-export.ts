/**
 * Depreciation Export API
 * GET — export depreciable assets as CSV
 */

import type { NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { fmtDate } from '@/lib/fmtDate';
import {
  calculatePolicyDepreciation,
  toDepreciationMethod,
} from '@/modules/accounting/services/items/farDepreciationService';
import { IN_SERVICE_STATUSES } from '@/modules/accounting/services/items/depreciationRunPlan';

type Row = Record<string, unknown>;

export const DEPRECIATION_CSV_HEADER =
  'Asset Number,Name,Purchase Price,Book Value,Accum Depreciation,Useful Life (yrs),Salvage Value,Method,Monthly Depreciation';

/**
 * One CSV line per asset, with the monthly charge taken from the calculator the
 * monthly run posts from — so the export cannot quote a number the GL
 * disagrees with. It used to hard-code straight line.
 */
export function buildDepreciationCsv(assets: Row[], periodDate: string): string {
  return [
    DEPRECIATION_CSV_HEADER,
    ...assets.map((a) => {
      const pp = Number(a.purchase_price);
      const sv = Number(a.salvage_value || 0);
      const uly = Number(a.useful_life_years);
      const method = toDepreciationMethod(a.depreciation_method);
      const { monthlyDep } = calculatePolicyDepreciation({
        cost: pp,
        residualPct: pp > 0 ? sv / pp : 0,
        usefulLifeYears: uly,
        purchaseDate: fmtDate(a.purchase_date as string | Date),
        periodDate,
        openingAccDep: Number(a.accumulated_depreciation),
        method,
        ...(a.disposal_date ? { disposalDate: fmtDate(a.disposal_date as string | Date) } : {}),
      });
      return [
        csvCell(String(a.asset_number)),
        csvCell(String(a.name)),
        pp.toFixed(2),
        Number(a.current_book_value ?? pp).toFixed(2),
        Number(a.accumulated_depreciation).toFixed(2),
        String(uly),
        sv.toFixed(2),
        csvCell(method),
        monthlyDep.toFixed(2),
      ].join(',');
    }),
  ].join('\n');
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;

  try {
    // Read the register directly. This used to `fetch` `/api/assets` over HTTP
    // with the caller's cookie — a route that does not exist in this app, so
    // the export silently emitted a header-only CSV for every company.
    const assets = (await sql`
      SELECT asset_number, name, purchase_date, purchase_price, salvage_value,
             useful_life_years, depreciation_method, disposal_date,
             COALESCE(accumulated_depreciation, 0) AS accumulated_depreciation,
             current_book_value
      FROM assets
      WHERE company_id = ${companyId}::UUID
        AND status = ANY(${IN_SERVICE_STATUSES as unknown as string[]}::TEXT[])
        AND purchase_price > 0
        AND useful_life_years > 0
      ORDER BY asset_number
    `) as Row[];

    const period = fmtDate(new Date());

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="depreciation-${period}.csv"`);
    return res.status(200).send(buildDepreciationCsv(assets, period));
  } catch (err) {
    log.error('Depreciation export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export depreciation data');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
