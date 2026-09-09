/**
 * Asset depreciation → GL, and the dual-track period run.
 *
 * Extracted from `glCrossModuleHooks.ts`, which was 518 lines against a 300
 * line cap before this change touched it. It is re-exported from there, so
 * every existing caller is unchanged.
 *
 * The date and the entry NUMBER come from the period being depreciated, never
 * from today — see the note on `postAssetDepreciationToGLThrows`.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { getSystemAccountId } from './systemAccountResolver';
import { lockAssetTaxBase, writeAssetTaxAccumulation } from './assetTaxAccumulation';
import {
  calculatePolicyDepreciation,
  calculateTaxDepreciation,
  calculateDeferredTax,
} from '@/modules/accounting/services/items/farDepreciationService';
import type { DbRow } from '@/types/db';

// ── Asset Depreciation → GL ────────────────────────────────────────────────

export async function postAssetDepreciationToGL(
  companyId: string,
  assetId: string,
  depreciationAmount: number,
  userId: string
): Promise<string | null> {
  // SAVEPOINT + swallow: legacy single-asset entry point. The dual-track run
  // (postDualDepreciationToLedger) manages its own savepoint so ledger row +
  // GL entry commit or roll back TOGETHER — use that for depreciation runs.
  try {
    return await withSavepoint('asset_dep_gl', () =>
      postAssetDepreciationToGLThrows(companyId, assetId, depreciationAmount, userId),
    );
  } catch (err) {
    log.error('Failed to post asset depreciation to GL', { assetId, error: err }, 'accounting');
    return null;
  }
}

/** Throwing core — callers own savepoint/error policy. */
async function postAssetDepreciationToGLThrows(
  companyId: string,
  assetId: string,
  depreciationAmount: number,
  userId: string,
  /**
   * The period being depreciated, YYYY-MM-DD. The journal's DATE and its
   * idempotency NUMBER both come from it.
   *
   * They used to come from `new Date()` instead — `CURRENT_DATE` and
   * `DEP-<asset>-<today's month>` — while `asset_period_ledger` was keyed on
   * the period. The two idempotency keys therefore disagreed: running March
   * and then April within one calendar month wrote two subledger periods and
   * ONE journal, because the second collided with the first entry number and
   * was read as already posted. Accumulated depreciation then understated by a
   * whole period with nothing flagging it. Defaulting to today preserves the
   * old behaviour for the single legacy caller that passes no period, and all
   * 19 `auto_depreciation` entries in production carry an entry number whose
   * month equals their creation month — so no run has ever been made for a
   * period other than the current one and this is a no-op on history.
   */
  periodDate?: string,
): Promise<string | null> {
  if (depreciationAmount <= 0) return null;

  const asset = (await sql`
    SELECT id, asset_number, name FROM assets
    WHERE id = ${assetId} AND company_id = ${companyId}::UUID
  `) as DbRow[];

  if (!asset[0]) {
    log.warn('Asset not found for depreciation GL', { assetId }, 'accounting');
    return null;
  }

  const assetRow = asset[0];
  const assetNumber = String(assetRow.asset_number ?? '');
  const assetName = String(assetRow.name ?? '');

  // Idempotency: entry numbers are deterministic per asset+month
  // (DEP-<asset>-YYYY-MM, unique per company). A re-run within the month
  // previously hit 23505 for every already-posted asset — swallowed silently
  // before P1.5 made failures loud. Treat an existing entry as already
  // posted and return it instead of failing the asset.
  const period = periodDate ?? fmtDate(new Date());
  const entryNumber = `DEP-${assetNumber}-${period.slice(0, 7)}`;
  // reversed_at IS NULL: a REVERSED entry must NOT count as already-posted —
  // that would silently under-depreciate (assets.accumulated_depreciation is
  // never touched by reversal). With the number taken by the reversed
  // original, the INSERT below hits the unique index → savepoint rollback →
  // glFailed:true — a LOUD failure the run reports, which is the honest
  // outcome until a re-post path with suffixed numbering exists. Reachable only
  // through the LEGACY single-asset entry point now: in the dual run the plan's
  // `already_in_subledger` guard skips such an asset, with its reason, before
  // this is reached.
  const existing = (await sql`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${companyId} AND entry_number = ${entryNumber}
      AND reversed_at IS NULL
  `) as DbRow[];
  if (existing[0]) {
    log.info('Asset depreciation already posted this month — skipping', {
      assetId, entryId: String(existing[0].id),
    }, 'accounting');
    return String(existing[0].id);
  }

  const depExpenseId = await getSystemAccountId('depreciation_expense', companyId);
  const accumDepId = await getSystemAccountId('accumulated_depreciation', companyId);

  const entry = (await sql`
    INSERT INTO gl_journal_entries (
      company_id, entry_number, entry_date, description, source, status, created_by,
      posting_agent
    ) VALUES (
      ${companyId}, ${entryNumber}, ${period}::DATE,
      ${`Depreciation: ${assetName} (${assetNumber})`},
      'auto_depreciation', 'posted', ${userId},
      'system:asset-depreciation:v1'
    ) RETURNING id
  `) as DbRow[];

  const entryId = String(entry[0]!.id);

  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
    VALUES (${entryId}::UUID, ${depExpenseId}::UUID, ${depreciationAmount}, 0,
      ${`Depreciation: ${assetNumber}`}, ${companyId}::UUID)
  `;
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
    VALUES (${entryId}::UUID, ${accumDepId}::UUID, 0, ${depreciationAmount},
      ${`Depreciation: ${assetNumber}`}, ${companyId}::UUID)
  `;

  await sql`
    UPDATE assets SET
      accumulated_depreciation = COALESCE(accumulated_depreciation, 0) + ${depreciationAmount},
      current_book_value = COALESCE(purchase_price, 0) - (COALESCE(accumulated_depreciation, 0) + ${depreciationAmount}),
      updated_at = NOW()
    WHERE id = ${assetId} AND company_id = ${companyId}::UUID
  `;

  log.info('Asset depreciation GL posted', { assetId, entryId, depreciationAmount }, 'accounting');
  return entryId;
}

// ── Enhanced Depreciation Run → GL + asset_period_ledger ──────────────────────

interface DualDepInput {
  cost: number;
  residualPct: number;
  usefulLifeYears: number;
  taxLifeYears: number;
  purchaseDate: string;
  periodDate: string;
  openingAccDep: number;
  deferredTaxRate: number;
  disposalDate?: string;
}

/**
 * Runs dual policy + tax depreciation for one asset/period and writes the result
 * to asset_period_ledger (upsert). Returns the policy depreciation amount for
 * GL posting.
 */
export async function postDualDepreciationToLedger(
  companyId: string,
  assetId: string,
  input: DualDepInput,
  yyyymm: string,
  userId: string
): Promise<{ policyDep: number; taxDep: number; entryId: string | null; glFailed: boolean }> {
  const policy = calculatePolicyDepreciation({
    cost: input.cost,
    residualPct: input.residualPct,
    usefulLifeYears: input.usefulLifeYears,
    purchaseDate: input.purchaseDate,
    periodDate: input.periodDate,
    openingAccDep: input.openingAccDep,
    disposalDate: input.disposalDate,
  });

  // The tax figures are computed INSIDE the savepoint, once the asset row is
  // locked and the subledger has been read. `DualDepInput` deliberately carries
  // NO tax opening: the only value a caller could pass is a pre-transaction read
  // of the cache column, which is the defect this module exists to stop relying
  // on. See `assetTaxAccumulation.ts`. Reported as 0 if the savepoint fails
  // before the calculation.
  let taxDep = 0;

  // Ledger row + GL entry commit or roll back TOGETHER: a subledger period
  // row without its backing journal (or vice versa) permanently skews
  // closing accumulated depreciation / carrying amounts, because the next
  // period's run computes from the persisted opening balances. One SAVEPOINT
  // per asset also stops a single bad asset from poisoning the request
  // transaction and 500ing the rest of the run (P1.5, observed live).
  try {
    const entryId = await withSavepoint('asset_dep_period', async () => {
      const taxBase = await lockAssetTaxBase(companyId, assetId, yyyymm);
      const tax = calculateTaxDepreciation({
        cost: input.cost,
        taxLifeYears: input.taxLifeYears,
        purchaseDate: input.purchaseDate,
        periodDate: input.periodDate,
        taxOpeningAccDep: taxBase.openingForPeriod,
        disposalDate: input.disposalDate,
      });
      taxDep = tax.monthlyTaxDep;
      const deferred = calculateDeferredTax({
        policyCarryingAmount: policy.policyCarryingAmount,
        taxCarryingAmount: tax.taxCarryingAmount,
        deferredTaxRate: input.deferredTaxRate,
      });

      await sql`
        INSERT INTO asset_period_ledger (
          company_id, asset_id, period_date, yyyymm,
          policy_cost, policy_opening_acc_dep, policy_current_dep,
          policy_closing_acc_dep, policy_carrying_amount, policy_dep_rate,
          tax_cost, tax_opening_acc_dep, tax_current_dep,
          tax_closing_acc_dep, tax_carrying_amount, deferred_tax
        ) VALUES (
          ${companyId}::UUID, ${assetId}::UUID,
          ${input.periodDate}::DATE, ${yyyymm},
          ${input.cost}, ${policy.openingAccDep}, ${policy.monthlyDep},
          ${policy.closingAccDep}, ${policy.policyCarryingAmount}, ${policy.depRate},
          ${input.cost}, ${tax.openingTaxAccDep}, ${tax.monthlyTaxDep},
          ${tax.closingTaxAccDep}, ${tax.taxCarryingAmount}, ${deferred.deferredTax}
        )
        ON CONFLICT (company_id, asset_id, yyyymm) DO UPDATE SET
          policy_current_dep      = EXCLUDED.policy_current_dep,
          policy_closing_acc_dep  = EXCLUDED.policy_closing_acc_dep,
          policy_carrying_amount  = EXCLUDED.policy_carrying_amount,
          tax_current_dep         = EXCLUDED.tax_current_dep,
          tax_closing_acc_dep     = EXCLUDED.tax_closing_acc_dep,
          tax_carrying_amount     = EXCLUDED.tax_carrying_amount,
          deferred_tax            = EXCLUDED.deferred_tax,
          updated_at              = NOW()
      `;
      // The asset column is a CACHE of the subledger, so it is set from the
      // subledger total — every other period's charge plus this one's — not
      // from the row just written. That is what keeps a back-posted period's
      // charge in the accumulation instead of losing it, and what makes a
      // same-period re-post idempotent.
      await writeAssetTaxAccumulation(
        companyId, assetId, input.cost, taxBase.accumulatedElsewhere + tax.monthlyTaxDep,
      );
      return postAssetDepreciationToGLThrows(
        companyId, assetId, policy.monthlyDep, userId, input.periodDate,
      );
    });

    log.info('Dual depreciation ledger updated', {
      assetId, yyyymm, policyDep: policy.monthlyDep, taxDep,
    }, 'accounting');

    return { policyDep: policy.monthlyDep, taxDep, entryId, glFailed: false };
  } catch (err) {
    // Whole period rolled back for this asset — nothing persisted. Report
    // loudly so the run's caller can surface a failure count.
    log.error('Dual depreciation period failed — rolled back', { assetId, yyyymm, error: err }, 'accounting');
    return { policyDep: policy.monthlyDep, taxDep, entryId: null, glFailed: true };
  }
}
