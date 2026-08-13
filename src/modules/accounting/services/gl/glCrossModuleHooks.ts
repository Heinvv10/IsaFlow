/**
 * Cross-Module GL Integration Hooks
 * - Asset depreciation → DR Depreciation Expense, CR Accumulated Depreciation
 * - Asset disposal     → DR Acc Dep + Bank, CR Asset Cost ± Disposal P&L
 * - Below-threshold    → DR Expense, CR Bank
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from './systemAccountResolver';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
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
  userId: string
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
  const entryNumber = `DEP-${assetNumber}-${new Date().toISOString().slice(0, 7)}`;
  // reversed_at IS NULL: a REVERSED entry must NOT count as already-posted —
  // that would silently under-depreciate (assets.accumulated_depreciation is
  // never touched by reversal). With the number taken by the reversed
  // original, the INSERT below hits the unique index → savepoint rollback →
  // glFailed:true — a LOUD failure the run reports, which is the honest
  // outcome until a re-post path with suffixed numbering exists.
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
      ${companyId}, ${entryNumber}, CURRENT_DATE,
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

  // Ledger row + GL entry commit or roll back TOGETHER: a subledger period
  // row without its backing journal (or vice versa) permanently skews
  // closing accumulated depreciation / carrying amounts, because the next
  // period's run computes from the persisted opening balances. One SAVEPOINT
  // per asset also stops a single bad asset from poisoning the request
  // transaction and 500ing the rest of the run (P1.5, observed live).
  try {
    const entryId = await withSavepoint('asset_dep_period', async () => {
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
      return postAssetDepreciationToGLThrows(companyId, assetId, policy.monthlyDep, userId);
    });

    log.info('Dual depreciation ledger updated', {
      assetId, yyyymm, policyDep: policy.monthlyDep, taxDep: tax.monthlyTaxDep,
    }, 'accounting');

    return { policyDep: policy.monthlyDep, taxDep: tax.monthlyTaxDep, entryId, glFailed: false };
  } catch (err) {
    // Whole period rolled back for this asset — nothing persisted. Report
    // loudly so the run's caller can surface a failure count.
    log.error('Dual depreciation period failed — rolled back', { assetId, yyyymm, error: err }, 'accounting');
    return { policyDep: policy.monthlyDep, taxDep: tax.monthlyTaxDep, entryId: null, glFailed: true };
  }
}

// ── Asset Disposal → GL ───────────────────────────────────────────────────────

/**
 * Thrown when an asset (and its category) carries no gl_asset_account_id, so
 * the disposal has no credit leg. Typed rather than a bare Error because
 * withErrorHandler masks messages in production — the route matches on
 * `instanceof` to answer 400 with the fix ("set gl_asset_account_id") instead
 * of an opaque 500.
 */
export function missingAssetAccountMessage(assetNumber: string): string {
  return `Asset ${assetNumber} has no fixed-asset account: set gl_asset_account_id on the asset or its category before disposing`;
}

export class MissingAssetAccountError extends Error {
  readonly assetNumber: string;
  constructor(assetNumber: string) {
    super(missingAssetAccountMessage(assetNumber));
    this.name = 'MissingAssetAccountError';
    this.assetNumber = assetNumber;
  }
}

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
 *
 * Routed through createJournalEntry/postJournalEntry rather than hand-rolled
 * INSERTs. The old shape inserted the header straight into status='posted' and
 * appended each leg behind its own `if`; trg_gl_je_balanced fires only on
 * UPDATE, so nothing checked the result. An asset with no category account
 * dropped the sole credit leg and posted debits against nothing. Building the
 * lines first and handing them to the posting service means validateJournalEntry
 * sees the whole entry before any of it reaches the ledger.
 *
 * Errors propagate. This used to log-and-return-null, which let
 * pages/api/accounting/assets/[assetId]/dispose.ts answer 200 with
 * journalEntryId: null — how production ended up with a disposed asset carrying
 * no journal at all. withAuth rolls the request transaction back on a throw, so
 * the asset_disposals row written earlier in the request goes with it.
 */
export async function postAssetDisposalToGL(
  companyId: string,
  input: DisposalGLInput,
  userId: string
): Promise<string | null> {
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

  // The Cr leg for the whole entry. Without it there is nothing to balance the
  // acc-dep/bank/loss debits against, so refuse rather than post a half-entry —
  // the asset keeps its cost on the balance sheet and the operator gets told to
  // set gl_asset_account_id on the asset or its category.
  if (!assetAccountId) {
    throw new MissingAssetAccountError(assetNumber);
  }

  const accumDepId = await getSystemAccountId('accumulated_depreciation', companyId);
  const bankId = await getSystemAccountId('bank', companyId);
  const plId = await getSystemAccountId('disposal_profit_loss', companyId);

  const lines: JournalLineInput[] = [];

  if (input.policyAccDep > 0) {
    lines.push({
      glAccountId: accumDepId, debit: input.policyAccDep, credit: 0,
      description: `Disposal acc dep: ${tag}`,
    });
  }

  if (input.proceeds > 0) {
    lines.push({
      glAccountId: bankId, debit: input.proceeds, credit: 0,
      description: `Disposal proceeds: ${tag}`,
    });
  }

  if (input.gainLoss < 0) {
    lines.push({
      glAccountId: plId, debit: Math.abs(input.gainLoss), credit: 0,
      description: `Loss on disposal: ${tag}`,
    });
  } else if (input.gainLoss > 0) {
    lines.push({
      glAccountId: plId, debit: 0, credit: input.gainLoss,
      description: `Gain on disposal: ${tag}`,
    });
  }

  lines.push({
    glAccountId: assetAccountId, debit: 0, credit: input.cost,
    description: `Disposal asset cost: ${tag}`,
  });

  // DIS-<asset>-<month> goes in reference, not entry_number: entry_number is
  // UNIQUE per company and generated by trg_gl_je_entry_number, so two
  // disposals touching one asset in a month used to collide.
  const entry = await createJournalEntry(companyId, {
    entryDate: input.disposalDate,
    description: `Disposal: ${tag}${input.notes ? ` — ${input.notes}` : ''}`,
    source: 'auto_asset_disposal',
    reference: `DIS-${assetNumber}-${input.disposalDate.slice(0, 7)}`,
    lines,
  }, userId, { postingAgent: 'system:asset-disposal:v1' });

  await postJournalEntry(companyId, entry.id, userId);

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
    assetId: input.assetId, entryId: entry.id, gainLoss: input.gainLoss,
  }, 'accounting');
  return entry.id;
}

// ── Below-Threshold Asset → GL (Immediate Expense) ──────────────────────────

/**
 * Posts expense journal for a below-capitalization-threshold asset:
 *   Dr Default Expense
 *   Cr Bank
 *
 * Same treatment as postAssetDisposalToGL: 'asset_expense' was never a value
 * gl_journal_entries_source_check accepted, and the swallow turned the 23514
 * into a null return, so nothing was ever expensed. Posts through the validated
 * service now and lets failures reach the caller.
 */
export async function postCapitalizationExpenseToGL(
  companyId: string,
  assetId: string,
  cost: number,
  userId: string
): Promise<string | null> {
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

  const entry = await createJournalEntry(companyId, {
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Below-threshold expense: ${tag}`,
    source: 'auto_asset_expense',
    reference: `EXP-${assetNumber}-${new Date().toISOString().slice(0, 10)}`,
    lines: [
      { glAccountId: expenseId, debit: cost, credit: 0, description: `Below-threshold expense: ${tag}` },
      { glAccountId: bankId, debit: 0, credit: cost, description: `Below-threshold expense: ${tag}` },
    ],
  }, userId, { postingAgent: 'system:asset-expense:v1' });

  await postJournalEntry(companyId, entry.id, userId);

  await sql`
    UPDATE assets SET below_threshold = true, updated_at = NOW()
    WHERE id = ${assetId} AND company_id = ${companyId}::UUID
  `;

  log.info('Below-threshold expense posted', { assetId, entryId: entry.id, cost }, 'accounting');
  return entry.id;
}
