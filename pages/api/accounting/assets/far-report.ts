/**
 * GET /api/accounting/assets/far-report?asAt=YYYY-MM-DD
 * Returns the full Fixed Asset Register as at any historical date.
 * Reads from asset_period_ledger — the most recent period ≤ asAt per asset.
 * Matches the format of the reference Excel FAR tab (PRD-04 section 9).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const { asAt } = req.query as { asAt?: string };

  // Default to today if not provided
  const asAtDate = asAt ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAtDate)) {
    return apiResponse.badRequest(res, 'asAt must be YYYY-MM-DD');
  }
  const asAtYYYYMM = asAtDate.replace(/-/g, '').slice(0, 6);

  // Get the latest period ledger row for each asset where yyyymm ≤ asAt period
  const rows = (await sql`
    SELECT DISTINCT ON (apl.asset_id)
      a.id                                  AS asset_id,
      a.asset_number,
      a.name                                AS asset_name,
      a.description,
      a.serial_number,
      a.custodian,
      a.location,
      a.production_code,
      a.purchase_date,
      a.status,
      a.below_threshold,
      c.code                                AS category_code,
      c.name                                AS category_name,
      COALESCE(c.ias16_group, 'OA')         AS ias16_group,
      COALESCE(c.tax_code, c.code)          AS tax_code,
      COALESCE(a.tax_useful_life_years,
               a.tax_life_years,
               c.tax_life_years)            AS tax_life_years,
      COALESCE(a.useful_life_years,
               c.useful_life_years)         AS policy_life_years,
      COALESCE(c.residual_pct, 0)           AS residual_pct,
      apl.yyyymm,
      apl.period_date,
      -- Policy track
      apl.policy_cost,
      apl.policy_closing_acc_dep            AS policy_acc_dep,
      apl.policy_carrying_amount            AS policy_ca,
      apl.policy_current_dep               AS policy_current_dep,
      apl.policy_profit_loss,
      -- Tax track
      apl.tax_cost,
      apl.tax_closing_acc_dep              AS tax_acc_dep,
      apl.tax_carrying_amount              AS tax_ca,
      apl.tax_current_dep                  AS tax_current_dep,
      apl.tax_profit_loss,
      -- Deferred tax
      apl.deferred_tax
    FROM asset_period_ledger apl
    JOIN assets a ON a.id = apl.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE apl.company_id = ${companyId}::UUID
      AND apl.yyyymm <= ${asAtYYYYMM}
    ORDER BY apl.asset_id, apl.yyyymm DESC
  `) as Row[];

  const toNum = (v: unknown) => Number(v ?? 0);
  const toStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));

  const assets = rows.map(r => ({
    assetId: toStr(r.asset_id),
    assetNumber: toStr(r.asset_number),
    assetName: toStr(r.asset_name),
    description: toStr(r.description),
    serialNumber: toStr(r.serial_number),
    custodian: toStr(r.custodian),
    location: toStr(r.location),
    productionCode: toStr(r.production_code),
    purchaseDate: toStr(r.purchase_date),
    status: toStr(r.status),
    belowThreshold: Boolean(r.below_threshold),
    categoryCode: toStr(r.category_code),
    categoryName: toStr(r.category_name),
    ias16Group: toStr(r.ias16_group),
    taxCode: toStr(r.tax_code),
    taxLifeYears: toNum(r.tax_life_years),
    policyLifeYears: toNum(r.policy_life_years),
    residualPct: toNum(r.residual_pct),
    // Policy track
    policyCost: toNum(r.policy_cost),
    policyAccDep: toNum(r.policy_acc_dep),
    policyCA: toNum(r.policy_ca),
    policyCurrentDep: toNum(r.policy_current_dep),
    policyProfitLoss: toNum(r.policy_profit_loss),
    // Tax track
    taxCost: toNum(r.tax_cost),
    taxAccDep: toNum(r.tax_acc_dep),
    taxCA: toNum(r.tax_ca),
    taxCurrentDep: toNum(r.tax_current_dep),
    taxProfitLoss: toNum(r.tax_profit_loss),
    // Deferred tax
    deferredTax: toNum(r.deferred_tax),
    asAtYYYYMM: toStr(r.yyyymm),
  }));

  // Summary totals
  const totals = assets.reduce(
    (acc, a) => {
      acc.policyCost += a.policyCost;
      acc.policyAccDep += a.policyAccDep;
      acc.policyCA += a.policyCA;
      acc.taxCost += a.taxCost;
      acc.taxAccDep += a.taxAccDep;
      acc.taxCA += a.taxCA;
      acc.deferredTax += a.deferredTax;
      return acc;
    },
    { policyCost: 0, policyAccDep: 0, policyCA: 0, taxCost: 0, taxAccDep: 0, taxCA: 0, deferredTax: 0 },
  );

  return apiResponse.success(res, { asAt: asAtDate, asAtYYYYMM, assets, totals });
}

export default withAuth(withErrorHandler(handler));
