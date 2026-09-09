/**
 * GET /api/accounting/assets/afs-summary?period=YYYYMM
 * Returns IAS 16 PPE movement note data grouped by ias16_group.
 * Feeds the AFS note 3 — Property, Plant and Equipment.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { aggregatePpeMovements, type AssetPriorYearSnapshot, type AssetCurrentYearMovement } from '@/modules/accounting/services/items/farAfsService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const { period } = req.query as { period?: string };

  if (!period || !/^\d{6}$/.test(period)) {
    return apiResponse.badRequest(res, 'period must be YYYYMM (e.g. 202312)');
  }

  // Derive prior year end period (same month, prior year)
  const year = parseInt(period.slice(0, 4), 10);
  const month = period.slice(4, 6);
  const priorYYYYMM = `${year - 1}${month}`;
  // Current year range: from Jan of current year to the period
  const currentYearStart = `${year}01`;

  // Prior year closing snapshot per asset (last available period ≤ priorYYYYMM)
  const priorRows = (await sql`
    SELECT DISTINCT ON (apl.asset_id)
      apl.asset_id,
      COALESCE(c.ias16_group, 'OA') AS ias16_group,
      apl.policy_cost               AS cost,
      apl.policy_closing_acc_dep    AS acc_dep,
      apl.policy_carrying_amount    AS carrying_amount
    FROM asset_period_ledger apl
    JOIN assets a ON a.id = apl.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE apl.company_id = ${companyId}::UUID
      AND apl.yyyymm <= ${priorYYYYMM}
    ORDER BY apl.asset_id, apl.yyyymm DESC
  `) as Row[];

  // Current year movements: additions, disposals, depreciation per asset
  const movementRows = (await sql`
    SELECT
      apl.asset_id,
      COALESCE(c.ias16_group, 'OA') AS ias16_group,
      -- Additions: cost of assets first appearing in the current year. The first
      -- appearance is taken over the asset's WHOLE ledger history — MIN over the
      -- rows this query selects is bounded below by the period filter and would
      -- be true for every asset, counting an old asset as an addition as well as
      -- as opening cost.
      CASE WHEN (SELECT MIN(p.yyyymm) FROM asset_period_ledger p
                  WHERE p.company_id = ${companyId}::UUID
                    AND p.asset_id = apl.asset_id) >= ${currentYearStart}
           THEN MAX(apl.policy_cost) ELSE 0 END AS additions,
      -- Disposals: cost + acc dep if disposed in the year
      COALESCE(SUM(CASE WHEN apl.disposal_proceeds IS NOT NULL THEN apl.policy_cost ELSE 0 END), 0) AS disposal_cost,
      COALESCE(SUM(CASE WHEN apl.disposal_proceeds IS NOT NULL THEN apl.policy_closing_acc_dep ELSE 0 END), 0) AS disposal_acc_dep,
      SUM(apl.policy_current_dep) AS depreciation_charge
    FROM asset_period_ledger apl
    JOIN assets a ON a.id = apl.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE apl.company_id = ${companyId}::UUID
      AND apl.yyyymm >= ${currentYearStart}
      AND apl.yyyymm <= ${period}
    GROUP BY apl.asset_id, c.ias16_group
  `) as Row[];

  const priorSnapshots: AssetPriorYearSnapshot[] = priorRows.map(r => ({
    assetId: String(r.asset_id),
    ias16Group: String(r.ias16_group ?? 'OA'),
    cost: Number(r.cost ?? 0),
    accDep: Number(r.acc_dep ?? 0),
    carryingAmount: Number(r.carrying_amount ?? 0),
  }));

  const movements: AssetCurrentYearMovement[] = movementRows.map(r => ({
    assetId: String(r.asset_id),
    ias16Group: String(r.ias16_group ?? 'OA'),
    additions: Number(r.additions ?? 0),
    disposalCost: Number(r.disposal_cost ?? 0),
    disposalAccDep: Number(r.disposal_acc_dep ?? 0),
    depreciationCharge: Number(r.depreciation_charge ?? 0),
  }));

  const groups = aggregatePpeMovements(priorSnapshots, movements);

  return apiResponse.success(res, { period, groups });
}

export default withAuth(withErrorHandler(handler));
