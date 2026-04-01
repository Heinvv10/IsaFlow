/**
 * Asset Depreciation API
 * POST — run monthly depreciation for all eligible assets
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postAssetDepreciationToGL } from '@/modules/accounting/services/glCrossModuleHooks';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const userId = String(req.user.id);

  // Find assets eligible for depreciation:
  // - Status = available or assigned (active assets)
  // - Has purchase_price and useful_life_years
  // - current_book_value > salvage_value
  const assets = (await sql`
    SELECT id, asset_number, name, purchase_price, useful_life_years,
           salvage_value, current_book_value, accumulated_depreciation
    FROM assets
    WHERE company_id = ${companyId}::UUID
      AND status IN ('available', 'assigned', 'in_maintenance')
      AND purchase_price IS NOT NULL
      AND purchase_price > 0
      AND useful_life_years IS NOT NULL
      AND useful_life_years > 0
      AND COALESCE(current_book_value, purchase_price) > COALESCE(salvage_value, 0)
  `) as Row[];

  let processed = 0;
  let skipped = 0;
  const results: { assetNumber: string; amount: number; entryId: string | null }[] = [];

  for (const asset of assets) {
    const purchasePrice = Number(asset.purchase_price);
    const salvageValue = Number(asset.salvage_value || 0);
    const usefulLifeYears = Number(asset.useful_life_years);
    const bookValue = Number(asset.current_book_value ?? purchasePrice);

    // Straight-line monthly depreciation
    const annualDepreciation = (purchasePrice - salvageValue) / usefulLifeYears;
    const monthlyDepreciation = Math.round((annualDepreciation / 12) * 100) / 100;

    // Don't depreciate below salvage value
    const maxDepreciation = Math.max(0, bookValue - salvageValue);
    const amount = Math.min(monthlyDepreciation, maxDepreciation);

    if (amount < 0.01) { skipped++; continue; }

    const entryId = await postAssetDepreciationToGL(companyId, String(asset.id), amount, userId);
    results.push({ assetNumber: String(asset.asset_number), amount, entryId });
    processed++;
  }

  log.info('Depreciation run completed', { processed, skipped, total: assets.length }, 'accounting');

  return apiResponse.success(res, {
    processed,
    skipped,
    total: assets.length,
    results,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('admin')(withErrorHandler(handler)));
