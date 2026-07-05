/**
 * Asset Depreciation API — Enhanced FAR Engine (Phase 2)
 * POST — run dual policy + tax depreciation for all eligible assets.
 * Writes per-period results to asset_period_ledger and posts policy dep to GL.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postDualDepreciationToLedger } from '@/modules/accounting/services/gl/glCrossModuleHooks';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = String(req.user.id);

  // periodDate defaults to last day of current month; can be overridden for historical runs
  const { periodDate: periodDateParam } = req.body as { periodDate?: string };
  const now = new Date();
  const periodDate = periodDateParam ?? new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const yyyymm = periodDate.replace(/-/g, '').slice(0, 6);

  // Fetch all eligible assets with their category policy + tax lives
  const assets = (await sql`
    SELECT
      a.id, a.asset_number, a.name,
      a.purchase_price                              AS cost,
      a.purchase_date,
      COALESCE(a.accumulated_depreciation, 0)       AS policy_acc_dep,
      COALESCE(a.tax_accumulated_depreciation, 0)   AS tax_acc_dep,
      COALESCE(a.tax_opening_acc_dep, 0)            AS tax_opening_acc_dep,
      COALESCE(a.deferred_tax_rate, 0.27)           AS deferred_tax_rate,
      a.disposal_date,
      -- Category policy fields (asset-level overrides first, then category)
      COALESCE(a.useful_life_years, c.useful_life_years)          AS useful_life_years,
      COALESCE(a.salvage_value / NULLIF(a.purchase_price, 0), c.residual_pct, 0) AS residual_pct,
      COALESCE(a.tax_useful_life_years, c.tax_life_years)                        AS tax_life_years
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE a.company_id = ${companyId}::UUID
      AND a.status IN ('available', 'assigned', 'in_maintenance')
      AND a.purchase_price IS NOT NULL
      AND a.purchase_price > 0
      AND COALESCE(a.below_threshold, false) = false
  `) as Row[];

  let processed = 0;
  let skipped = 0;
  let glFailed = 0;
  const results: {
    assetNumber: string;
    policyDep: number;
    taxDep: number;
    entryId: string | null;
  }[] = [];

  for (const asset of assets) {
    const usefulLifeYears = Number(asset.useful_life_years ?? 0);
    // Fall back to policy life when no explicit tax life is configured
    const taxLifeYears = Number(asset.tax_life_years ?? asset.useful_life_years ?? 0);
    const cost = Number(asset.cost);
    const purchaseDate = String(asset.purchase_date instanceof Date
      ? asset.purchase_date.toISOString().slice(0, 10)
      : asset.purchase_date);

    if (usefulLifeYears <= 0) { skipped++; continue; }

    const disposalDate = asset.disposal_date
      ? String(asset.disposal_date instanceof Date
          ? asset.disposal_date.toISOString().slice(0, 10)
          : asset.disposal_date)
      : undefined;

    const { policyDep, taxDep, entryId, glFailed: assetGlFailed } = await postDualDepreciationToLedger(
      companyId,
      String(asset.id),
      {
        cost,
        residualPct: Number(asset.residual_pct ?? 0),
        usefulLifeYears,
        taxLifeYears,
        purchaseDate,
        periodDate,
        openingAccDep: Number(asset.policy_acc_dep),
        taxOpeningAccDep: Number(asset.tax_acc_dep),
        deferredTaxRate: Number(asset.deferred_tax_rate),
        disposalDate,
      },
      yyyymm,
      userId
    );

    if (assetGlFailed) {
      // The whole period rolled back for this asset (ledger row + GL entry
      // are atomic). Count it loudly — a silent partial run understates
      // accumulated depreciation until someone notices.
      glFailed++;
      results.push({ assetNumber: String(asset.asset_number), policyDep, taxDep, entryId: null });
      continue;
    }
    if (policyDep < 0.01 && taxDep < 0.01) { skipped++; continue; }

    results.push({ assetNumber: String(asset.asset_number), policyDep, taxDep, entryId });
    processed++;
  }

  log.info('Dual depreciation run completed', { processed, skipped, glFailed, total: assets.length, periodDate }, 'accounting');

  return apiResponse.success(res, {
    processed,
    skipped,
    glFailed,
    total: assets.length,
    periodDate,
    yyyymm,
    results,
  });
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
