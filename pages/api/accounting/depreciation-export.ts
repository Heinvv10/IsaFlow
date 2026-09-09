/**
 * Depreciation Export API
 * GET — export depreciable assets as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { fmtDate } from '@/lib/fmtDate';
import {
  calculatePolicyDepreciation,
  toDepreciationMethod,
} from '@/modules/accounting/services/items/farDepreciationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost:3004';
    const baseUrl = `${proto}://${host}`;
    const assetRes = await fetch(`${baseUrl}/api/assets?status=available,assigned,in_maintenance&limit=500`, {
      headers: { cookie: req.headers.cookie || '' },
    });
    const assetJson = await assetRes.json();
    const assets = (assetJson.data?.items || assetJson.data?.assets || assetJson.data || [])
      .filter((a: Record<string, unknown>) => Number(a.purchase_price) > 0 && Number(a.useful_life_years) > 0);

    const csvLines = [
      'Asset Number,Name,Purchase Price,Book Value,Accum Depreciation,Useful Life (yrs),Salvage Value,Method,Monthly Depreciation',
      ...assets.map((a: Record<string, unknown>) => {
        const pp = Number(a.purchase_price);
        const sv = Number(a.salvage_value || 0);
        const uly = Number(a.useful_life_years);
        const method = toDepreciationMethod(a.depreciation_method);
        // Same calculator the monthly run posts from, so the CSV cannot quote a
        // number the GL disagrees with. It used to hard-code straight line.
        const { monthlyDep: monthly } = calculatePolicyDepreciation({
          cost: pp,
          residualPct: pp > 0 ? sv / pp : 0,
          usefulLifeYears: uly,
          purchaseDate: fmtDate(a.purchase_date as string | Date),
          periodDate: fmtDate(new Date()),
          openingAccDep: Number(a.accumulated_depreciation || 0),
          method,
          ...(a.disposal_date ? { disposalDate: fmtDate(a.disposal_date as string | Date) } : {}),
        });
        return [
          csvCell(String(a.asset_number)),
          csvCell(String(a.name)),
          pp.toFixed(2),
          Number(a.current_book_value ?? pp).toFixed(2),
          Number(a.accumulated_depreciation || 0).toFixed(2),
          String(uly),
          sv.toFixed(2),
          csvCell(method),
          monthly.toFixed(2),
        ].join(',');
      }),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="depreciation-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Depreciation export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export depreciation data');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
