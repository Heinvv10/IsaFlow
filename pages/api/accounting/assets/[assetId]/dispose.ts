/**
 * POST /api/accounting/assets/:assetId/dispose
 * Dispose an asset with full policy + tax gain/loss calculation and GL posting.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { ledgerDaysOf } from '@/modules/accounting/services/gl/journalDateGuard';
import { journalDayWindowError } from '@/modules/accounting/utils/journalDateWindow';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateDisposalResult } from '@/modules/accounting/services/items/farDisposalService';
import {
  DISPOSAL_TYPES,
  UNSPECIFIED_DISPOSAL_METHOD,
  isDisposalType,
  isInService,
} from '@/modules/accounting/services/items/assetDisposalTypes';
import {
  postAssetDisposalToGL,
  missingAssetAccountMessage,
  resolveAssetAccountId,
} from '@/modules/accounting/services/gl/glCrossModuleHooks';

type Row = Record<string, unknown>;

// 9,999,999,999,999.99: the largest NUMERIC(15,2), gl_journal_lines.debit/credit.
const MAX_JOURNAL_TOTAL_CENTS = 999_999_999_999_999;
const PROCEEDS_TOO_LARGE = 'proceeds are too large: the disposal journal total would exceed 9,999,999,999,999.99';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const userId = String(req.user.id);
  const { assetId } = req.query as { assetId: string };

  const { proceeds = 0, disposalDate, disposalType, notes } = (req.body ?? {}) as {
    proceeds?: unknown;
    disposalDate?: unknown;
    disposalType?: string;
    notes?: string;
  };

  if (!disposalDate || typeof disposalDate !== 'string') return apiResponse.badRequest(res, 'disposalDate is required');
  // Proceeds before any write (a 4xx commits). Number() read [5] as 5, "0x10" as 16 and "" as 0, and "abc", a
  // negative or a sub-cent amount reached the journal and died there as a 500. One rule for both input types: the
  // text (a number's String(), so 1e-7, 1e+21, 0.1+0.2 and NaN fail; a string trimmed) must be a plain decimal with at
  // most 2 decimals, and the cents come from that text, never from n * 100 (doubles near 1e13 are too coarse).
  // The whole-rand part is exact below 2^53 cents; anything larger is far over the journal ceiling checked below.
  const proceedsText = typeof proceeds === 'number' ? String(proceeds) : typeof proceeds === 'string' ? proceeds.trim() : '';
  const proceedsMatch = /^(\d+)(?:\.(\d{1,2}))?$/.exec(proceedsText);
  if (!proceedsMatch) return apiResponse.badRequest(res, 'proceeds must be an amount of 0 or more, in whole cents');
  const proceedsCents = Number(proceedsMatch[1]) * 100 + Number((proceedsMatch[2] ?? '').padEnd(2, '0'));
  const proceedsNum = proceedsCents / 100;
  // Before any write: assets.disposal_type's CHECK (mig 361) would otherwise 500
  // after the asset_period_ledger row below.
  if (disposalType && !isDisposalType(disposalType)) {
    return apiResponse.badRequest(res, `disposalType must be one of: ${DISPOSAL_TYPES.join(', ')}`);
  }
  // The ledger-date window on the day Postgres reads (gl/journalDateGuard), BEFORE the disposal's first write: a 400
  // later would commit the ledger row and the disposal type without the journal (see the GL note below).
  const disposalDay = (await ledgerDaysOf([disposalDate])).get(disposalDate) ?? null;
  const outsideWindow = disposalDay === null ? null : journalDayWindowError(disposalDay);
  if (outsideWindow) return apiResponse.badRequest(res, outsideWindow);

  // Load asset with accumulated depreciation and category data
  // FOR NO KEY UPDATE: the already-disposed check below is only meaningful while
  // the row is held. Two concurrent disposals would otherwise both read
  // status != 'disposed' and both post a disposal journal for the same asset.
  // NO KEY (round 3, brk-fleet B1): this changes no key column, and FOR UPDATE
  // conflicted with the FOR KEY SHARE a bank-line link and a fleet-record create
  // take — while this waited on journal numbering, that closed a deadlock cycle.
  const assetRows = (await sql`
    SELECT
      a.id, a.asset_number, a.name, a.purchase_price AS cost,
      a.accumulated_depreciation AS policy_acc_dep,
      COALESCE(a.tax_accumulated_depreciation, 0) AS tax_acc_dep,
      a.status,
      a.category_id,
      a.gl_asset_account_id
    FROM assets a
    WHERE a.id = ${assetId}::UUID
      AND a.company_id = ${companyId}::UUID
    FOR NO KEY UPDATE
  `) as Row[];

  if (!assetRows[0]) return apiResponse.notFound(res, 'Asset not found');

  const asset = assetRows[0];
  if (asset.status === 'disposed') return apiResponse.badRequest(res, 'Asset is already disposed');
  // A written-off asset has already left the books: a disposal would post a second retirement journal.
  if (!isInService(String(asset.status))) {
    return apiResponse.badRequest(res, `Asset is ${String(asset.status)}: only an asset in service can be disposed`);
  }

  // The fixed-asset account is the disposal journal's only credit leg. Check it
  // HERE, before the asset_period_ledger write below: withAuth finalises on
  // `statusCode >= 500`, so a 4xx commits — a late 400 would leave the ledger
  // row behind with no journal. Uses the same resolver postAssetDisposalToGL
  // uses, so this gate and the service can never disagree about what counts as
  // resolvable (they did while the route ran its own COALESCE and the service
  // gained a fallback).
  if (!(await resolveAssetAccountId(companyId, assetId))) {
    return apiResponse.badRequest(res, missingAssetAccountMessage(String(asset.asset_number ?? assetId), assetId));
  }

  const cost = Number(asset.cost);
  const policyAccDep = Number(asset.policy_acc_dep ?? 0);
  const taxAccDep = Number(asset.tax_acc_dep ?? 0);
  // postAssetDisposalToGL posts no accumulated-depreciation leg for a value <= 0, but the gain/loss is struck on
  // cost - accumulated depreciation: a negative figure posts an unbalanced journal (a 500). Refused before any write.
  if (policyAccDep < 0) {
    return apiResponse.badRequest(res, `Asset ${String(asset.asset_number ?? assetId)} has negative accumulated depreciation; correct it before disposing`);
  }

  const calc = calculateDisposalResult({ cost, policyAccDep, taxAccDep, proceeds: proceedsNum });

  // The journal's debit and credit totals must each fit gl_journal_lines.debit/credit, NUMERIC(15,2), which
  // enforce_balanced_entry sums: refused here, before the first write. The legs mirror postAssetDisposalToGL
  // (glCrossModuleHooks.ts): Dr acc dep (if > 0) + proceeds (if > 0) + loss; Cr cost + gain.
  // Known limit: gl_account_balances' running per-account, per-period total is NUMERIC(15,2) too and depends on what
  // the account already holds, so it cannot be checked here; it only matters near 1e13 cumulative.
  const cents = (n: number) => Math.round(n * 100);
  const debitCents = cents(Math.max(0, policyAccDep)) + proceedsCents + cents(Math.max(0, -calc.policyGainLoss));
  const creditCents = cents(Math.max(0, cost)) + cents(Math.max(0, calc.policyGainLoss));
  if (Math.max(debitCents, creditCents) > MAX_JOURNAL_TOTAL_CENTS) return apiResponse.badRequest(res, PROCEEDS_TOO_LARGE);

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
      ${proceedsNum}, ${calc.policyGainLoss}, ${calc.taxGainLoss}
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
    proceeds: proceedsNum,
    disposalDate,
    notes,
  }, userId);

  // A null id means the hook found no asset to post for. The lock above makes
  // that unreachable today; if it ever happens, fail (5xx rolls everything
  // back) rather than log a disposal with no journal, which is exactly what
  // the fixed-asset reconciliation reports as an unposted disposal.
  if (!entryId) throw new Error(`Asset ${assetId} disposal posted no journal`);

  // The disposal log GET /api/accounting/assets-disposals lists. Written after
  // the journal so it always carries one; the same request transaction rolls
  // it back with everything else if anything here throws.
  await sql`
    INSERT INTO asset_disposals (
      asset_id, disposal_date, disposal_method, disposal_amount,
      book_value_at_disposal, gain_loss, reason, journal_entry_id, created_by
    ) VALUES (
      ${assetId}::UUID, ${disposalDate}::DATE, ${disposalType || UNSPECIFIED_DISPOSAL_METHOD}, ${proceedsNum},
      ${calc.policyCarryingAmount}, ${calc.policyGainLoss}, ${notes ?? null}, ${entryId}::UUID, ${userId}
    )
  `;

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

// withWriteAccess (owner/admin/manager) was missing: this route posts a GL
// journal and retires an asset, but was the only one of the accounting posting
// routes a `viewer` could call. receipt-to-journal, gl-import, expense-claims
// post and the sibling gl-account writer all carry it.
export default withAuth(withCsrf(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
