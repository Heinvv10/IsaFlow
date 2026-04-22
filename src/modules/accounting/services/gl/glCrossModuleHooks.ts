/**
 * Cross-Module GL Integration Hooks
 * - Asset depreciation → DR Depreciation Expense, CR Accumulated Depreciation
 * - Asset disposal     → DR Acc Dep + Bank, CR Asset Cost ± Disposal P&L
 * - Below-threshold    → DR Expense, CR Bank
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from './systemAccountResolver';
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
  try {
    if (depreciationAmount <= 0) return null;

    const asset = (await sql`
      SELECT id, asset_number, name FROM assets WHERE id = ${assetId}
    `) as DbRow[];

    if (!asset[0]) {
      log.warn('Asset not found for depreciation GL', { assetId }, 'accounting');
      return null;
    }

    const assetRow = asset[0];
    const assetNumber = String(assetRow.asset_number ?? '');
    const assetName = String(assetRow.name ?? '');

    const depExpenseId = await getSystemAccountId('depreciation_expense', companyId);
    const accumDepId = await getSystemAccountId('accumulated_depreciation', companyId);

    const entry = (await sql`
      INSERT INTO gl_journal_entries (
        company_id, entry_number, entry_date, description, source, status, created_by,
        posting_agent
      ) VALUES (
        ${companyId}, ${`DEP-${assetNumber}-${new Date().toISOString().slice(0, 7)}`}, CURRENT_DATE,
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
      WHERE id = ${assetId}
    `;

    log.info('Asset depreciation GL posted', { assetId, entryId, depreciationAmount }, 'accounting');
    return entryId;
  } catch (err) {
    log.error('Failed to post asset depreciation to GL', { assetId, error: err }, 'accounting');
    return null;
  }
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
  taxOpeningAccDep: number;
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
): Promise<{ policyDep: number; taxDep: number; entryId: string | null }> {
  const policy = calculatePolicyDepreciation({
    cost: input.cost,
    residualPct: input.residualPct,
    usefulLifeYears: input.usefulLifeYears,
    purchaseDate: input.purchaseDate,
    periodDate: input.periodDate,
    openingAccDep: input.openingAccDep,
    disposalDate: input.disposalDate,
  });

  const tax = calculateTaxDepreciation({
    cost: input.cost,
    taxLifeYears: input.taxLifeYears,
    purchaseDate: input.purchaseDate,
    periodDate: input.periodDate,
    taxOpeningAccDep: input.taxOpeningAccDep,
    disposalDate: input.disposalDate,
  });

  const deferred = calculateDeferredTax({
    policyCarryingAmount: policy.policyCarryingAmount,
    taxCarryingAmount: tax.taxCarryingAmount,
    deferredTaxRate: input.deferredTaxRate,
  });

  // Upsert period ledger row
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

  const entryId = await postAssetDepreciationToGL(companyId, assetId, policy.monthlyDep, userId);

  log.info('Dual depreciation ledger updated', {
    assetId, yyyymm, policyDep: policy.monthlyDep, taxDep: tax.monthlyTaxDep,
  }, 'accounting');

  return { policyDep: policy.monthlyDep, taxDep: tax.monthlyTaxDep, entryId };
}

// ── Asset Disposal → GL ───────────────────────────────────────────────────────

interface DisposalGLInput {
  assetId: string;
  policyAccDep: number;
  cost: number;
  gainLoss: number;
  proceeds: number;
  disposalDate: string;
  notes?: string;
}

/**
 * Posts disposal GL journal:
 *   Dr Accumulated Depreciation
 *   Dr Bank (if proceeds > 0)
 *   Dr/Cr Profit or Loss on Disposal
 *   Cr Fixed Asset at Cost (uses asset category gl_asset_account_id or fallback)
 */
export async function postAssetDisposalToGL(
  companyId: string,
  input: DisposalGLInput,
  userId: string
): Promise<string | null> {
  try {
    const assetRows = (await sql`
      SELECT a.id, a.asset_number, a.name,
             COALESCE(a.gl_asset_account_id, c.gl_asset_account_id) AS asset_account_id
      FROM assets a
      LEFT JOIN asset_categories c ON c.id = a.category_id
      WHERE a.id = ${input.assetId} AND a.company_id = ${companyId}::UUID
    `) as DbRow[];

    if (!assetRows[0]) {
      log.warn('Asset not found for disposal GL', { assetId: input.assetId }, 'accounting');
      return null;
    }

    const row = assetRows[0];
    const assetNumber = String(row.asset_number ?? '');
    const assetName = String(row.name ?? '');
    const assetAccountId = row.asset_account_id ? String(row.asset_account_id) : null;
    const tag = `${assetName} (${assetNumber})`;

    const accumDepId = await getSystemAccountId('accumulated_depreciation', companyId);
    const bankId = await getSystemAccountId('bank', companyId);
    const plId = await getSystemAccountId('disposal_profit_loss', companyId);

    const entry = (await sql`
      INSERT INTO gl_journal_entries (
        company_id, entry_number, entry_date, description, source, status, created_by,
        posting_agent
      ) VALUES (
        ${companyId}::UUID,
        ${`DIS-${assetNumber}-${input.disposalDate.slice(0, 7)}`},
        ${input.disposalDate}::DATE,
        ${`Disposal: ${tag}${input.notes ? ` — ${input.notes}` : ''}`},
        'asset_disposal', 'posted', ${userId},
        'system:asset-disposal:v1'
      ) RETURNING id
    `) as DbRow[];

    const entryId = String(entry[0]!.id);

    // Dr Accumulated Depreciation
    if (input.policyAccDep > 0) {
      await sql`
        INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
        VALUES (${entryId}::UUID, ${accumDepId}::UUID, ${input.policyAccDep}, 0,
          ${`Disposal acc dep: ${tag}`}, ${companyId}::UUID)
      `;
    }

    // Dr Bank (proceeds received)
    if (input.proceeds > 0) {
      await sql`
        INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
        VALUES (${entryId}::UUID, ${bankId}::UUID, ${input.proceeds}, 0,
          ${`Disposal proceeds: ${tag}`}, ${companyId}::UUID)
      `;
    }

    // Dr/Cr Profit or Loss on Disposal
    if (input.gainLoss < 0) {
      await sql`
        INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
        VALUES (${entryId}::UUID, ${plId}::UUID, ${Math.abs(input.gainLoss)}, 0,
          ${`Loss on disposal: ${tag}`}, ${companyId}::UUID)
      `;
    } else if (input.gainLoss > 0) {
      await sql`
        INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
        VALUES (${entryId}::UUID, ${plId}::UUID, 0, ${input.gainLoss},
          ${`Gain on disposal: ${tag}`}, ${companyId}::UUID)
      `;
    }

    // Cr Fixed Asset at Cost
    if (assetAccountId) {
      await sql`
        INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
        VALUES (${entryId}::UUID, ${assetAccountId}::UUID, 0, ${input.cost},
          ${`Disposal asset cost: ${tag}`}, ${companyId}::UUID)
      `;
    }

    // Update asset status to disposed
    await sql`
      UPDATE assets SET
        status = 'disposed',
        disposal_date = ${input.disposalDate}::DATE,
        disposal_amount = ${input.proceeds},
        disposal_gain_loss = ${input.gainLoss},
        updated_at = NOW()
      WHERE id = ${input.assetId} AND company_id = ${companyId}::UUID
    `;

    log.info('Asset disposal GL posted', {
      assetId: input.assetId, entryId, gainLoss: input.gainLoss,
    }, 'accounting');
    return entryId;
  } catch (err) {
    log.error('Failed to post asset disposal to GL', { assetId: input.assetId, error: err }, 'accounting');
    return null;
  }
}

// ── Below-Threshold Asset → GL (Immediate Expense) ──────────────────────────

/**
 * Posts expense journal for a below-capitalization-threshold asset:
 *   Dr Default Expense
 *   Cr Bank
 */
export async function postCapitalizationExpenseToGL(
  companyId: string,
  assetId: string,
  cost: number,
  userId: string
): Promise<string | null> {
  try {
    if (cost <= 0) return null;

    const assetRows = (await sql`
      SELECT id, asset_number, name FROM assets
      WHERE id = ${assetId} AND company_id = ${companyId}::UUID
    `) as DbRow[];

    if (!assetRows[0]) return null;

    const row = assetRows[0];
    const assetNumber = String(row.asset_number ?? '');
    const assetName = String(row.name ?? '');
    const tag = `${assetName} (${assetNumber})`;

    const expenseId = await getSystemAccountId('default_expense', companyId);
    const bankId = await getSystemAccountId('bank', companyId);

    const entry = (await sql`
      INSERT INTO gl_journal_entries (
        company_id, entry_number, entry_date, description, source, status, created_by,
        posting_agent
      ) VALUES (
        ${companyId}::UUID,
        ${`EXP-${assetNumber}-${new Date().toISOString().slice(0, 10)}`},
        CURRENT_DATE,
        ${`Below-threshold expense: ${tag}`},
        'asset_expense', 'posted', ${userId},
        'system:asset-expense:v1'
      ) RETURNING id
    `) as DbRow[];

    const entryId = String(entry[0]!.id);

    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
      VALUES (${entryId}::UUID, ${expenseId}::UUID, ${cost}, 0,
        ${`Below-threshold expense: ${tag}`}, ${companyId}::UUID)
    `;
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
      VALUES (${entryId}::UUID, ${bankId}::UUID, 0, ${cost},
        ${`Below-threshold expense: ${tag}`}, ${companyId}::UUID)
    `;

    await sql`
      UPDATE assets SET below_threshold = true, updated_at = NOW()
      WHERE id = ${assetId} AND company_id = ${companyId}::UUID
    `;

    log.info('Below-threshold expense posted', { assetId, entryId, cost }, 'accounting');
    return entryId;
  } catch (err) {
    log.error('Failed to post capitalization expense', { assetId, error: err }, 'accounting');
    return null;
  }
}
