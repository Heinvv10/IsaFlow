/**
 * GET /api/accounting/assets/:assetId/period-ledger
 * Returns all asset_period_ledger rows for a single asset, ordered by period.
 * Powers the dual-track Policy vs Tax tab on the asset detail page.
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
  const { assetId } = req.query as { assetId: string };

  // Verify asset belongs to this company
  const assetCheck = (await sql`
    SELECT id FROM assets WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (!assetCheck[0]) return apiResponse.notFound(res, 'Asset not found');

  const rows = (await sql`
    SELECT
      yyyymm,
      period_date,
      policy_cost,
      policy_opening_acc_dep,
      policy_current_dep,
      policy_closing_acc_dep,
      policy_carrying_amount,
      policy_dep_rate,
      tax_cost,
      tax_opening_acc_dep,
      tax_current_dep,
      tax_closing_acc_dep,
      tax_carrying_amount,
      deferred_tax,
      disposal_proceeds,
      policy_profit_loss,
      tax_profit_loss
    FROM asset_period_ledger
    WHERE company_id = ${companyId}::UUID
      AND asset_id = ${assetId}::UUID
    ORDER BY yyyymm ASC
  `) as Row[];

  const toNum = (v: unknown) => v != null ? Number(v) : null;
  const toStr = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');

  return apiResponse.success(res, rows.map(r => ({
    yyyymm: toStr(r.yyyymm),
    periodDate: toStr(r.period_date),
    policyCost: toNum(r.policy_cost),
    policyOpeningAccDep: toNum(r.policy_opening_acc_dep),
    policyCurrentDep: toNum(r.policy_current_dep),
    policyClosingAccDep: toNum(r.policy_closing_acc_dep),
    policyCarryingAmount: toNum(r.policy_carrying_amount),
    policyDepRate: toNum(r.policy_dep_rate),
    taxCost: toNum(r.tax_cost),
    taxOpeningAccDep: toNum(r.tax_opening_acc_dep),
    taxCurrentDep: toNum(r.tax_current_dep),
    taxClosingAccDep: toNum(r.tax_closing_acc_dep),
    taxCarryingAmount: toNum(r.tax_carrying_amount),
    deferredTax: toNum(r.deferred_tax),
    disposalProceeds: toNum(r.disposal_proceeds),
    policyProfitLoss: toNum(r.policy_profit_loss),
    taxProfitLoss: toNum(r.tax_profit_loss),
  })));
}

export default withAuth(withErrorHandler(handler));
