/**
 * POST /api/accounting/assets/:assetId/dispose
 * Dispose an asset with full policy + tax gain/loss calculation and GL posting.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateDisposalResult } from '@/modules/accounting/services/items/farDisposalService';
import { postAssetDisposalToGL, missingAssetAccountMessage } from '@/modules/accounting/services/gl/glCrossModuleHooks';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const userId = String(req.user.id);
  const { assetId } = req.query as { assetId: string };

  const { proceeds = 0, disposalDate, disposalType, notes } = req.body as {
    proceeds?: number;
    disposalDate?: string;
    disposalType?: string;
    notes?: string;
  };

  if (!disposalDate) return apiResponse.badRequest(res, 'disposalDate is required');

  // Load asset with accumulated depreciation and category data
  const assetRows = (await sql`
    SELECT
      a.id, a.asset_number, a.name, a.purchase_price AS cost,
      a.accumulated_depreciation AS policy_acc_dep,
      COALESCE(a.tax_accumulated_depreciation, 0) AS tax_acc_dep,
      a.status,
      a.category_id,
      a.gl_asset_account_id,
      COALESCE(a.gl_asset_account_id, c.gl_asset_account_id) AS effective_asset_account_id
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE a.id = ${assetId}::UUID
      AND a.company_id = ${companyId}::UUID
  `) as Row[];

  if (!assetRows[0]) return apiResponse.notFound(res, 'Asset not found');

  const asset = assetRows[0];
  if (asset.status === 'disposed') return apiResponse.badRequest(res, 'Asset is already disposed');

  // The fixed-asset account is the disposal journal's only credit leg. Check it
  // HERE, before the asset_period_ledger write below: withAuth finalises on
  // `statusCode >= 500`, so a 4xx commits — a late 400 would leave the ledger
  // row behind with no journal. postAssetDisposalToGL enforces the same rule
  // (MissingAssetAccountError) for callers that don't come through this route.
  if (!asset.effective_asset_account_id) {
    return apiResponse.badRequest(res, missingAssetAccountMessage(String(asset.asset_number ?? assetId)));
  }

  const cost = Number(asset.cost);
  const policyAccDep = Number(asset.policy_acc_dep ?? 0);
  const taxAccDep = Number(asset.tax_acc_dep ?? 0);

  const calc = calculateDisposalResult({ cost, policyAccDep, taxAccDep, proceeds: Number(proceeds) });

  log.info('Asset disposal calculated', {
    assetId, policyGainLoss: calc.policyGainLoss,
    taxGainLoss: calc.taxGainLoss, recoupment: calc.recoupment,
  }, 'accounting');

  // Update asset_period_ledger disposal fields for current period
  const yyyymm = disposalDate.replace(/-/g, '').slice(0, 6);
  await sql`
    INSERT INTO asset_period_ledger (
      company_id, asset_id, period_date, yyyymm,
      policy_cost, policy_opening_acc_dep, policy_current_dep,
      policy_closing_acc_dep, policy_carrying_amount,
      tax_cost, tax_opening_acc_dep, tax_current_dep,
      tax_closing_acc_dep, tax_carrying_amount,
      disposal_proceeds, policy_profit_loss, tax_profit_loss
    ) VALUES (
      ${companyId}::UUID, ${assetId}::UUID,
      ${disposalDate}::DATE, ${yyyymm},
      ${cost}, ${policyAccDep}, 0,
      ${policyAccDep}, ${calc.policyCarryingAmount},
      ${cost}, ${taxAccDep}, 0,
      ${taxAccDep}, ${calc.taxCarryingAmount},
      ${Number(proceeds)}, ${calc.policyGainLoss}, ${calc.taxGainLoss}
    )
    ON CONFLICT (company_id, asset_id, yyyymm) DO UPDATE SET
      disposal_proceeds   = EXCLUDED.disposal_proceeds,
      policy_profit_loss  = EXCLUDED.policy_profit_loss,
      tax_profit_loss     = EXCLUDED.tax_profit_loss,
      updated_at          = NOW()
  `;

  // Update disposal_type if provided
  if (disposalType) {
    await sql`
      UPDATE assets SET disposal_type = ${disposalType} WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  // A GL failure here must fail the whole disposal. postAssetDisposalToGL used
  // to swallow its errors and return null, which let this route answer 200 with
  // journalEntryId: null — an asset retired from the register with no journal.
  // It throws now, and withAuth rolls back on the resulting 5xx, taking the
  // asset_period_ledger row and the assets.disposal_type update above with it.
  //
  // Note the 400 for a missing asset account is raised BEFORE any write (see
  // above), not from a catch here: withAuth finalises on `statusCode >= 500`,
  // so a 4xx COMMITs — 400-ing at this point would persist the disposal row
  // without its journal, which is the bug being fixed.
  const entryId = await postAssetDisposalToGL(companyId, {
    assetId,
    policyAccDep,
    cost,
    gainLoss: calc.policyGainLoss,
    proceeds: Number(proceeds),
    disposalDate,
    notes,
  }, userId);

  return apiResponse.success(res, {
    assetId,
    policyCarryingAmount: calc.policyCarryingAmount,
    taxCarryingAmount: calc.taxCarryingAmount,
    policyGainLoss: calc.policyGainLoss,
    taxGainLoss: calc.taxGainLoss,
    recoupment: calc.recoupment,
    hasRecoupment: calc.hasRecoupment,
    capitalGain: calc.capitalGain,
    journalEntryId: entryId,
  });
}

export default withAuth(withCsrf(withErrorHandler(handler)));
