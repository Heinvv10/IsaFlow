/**
 * The fixed asset register against the general ledger, DECOMPOSED.
 *
 * `getAssetGlReconciliation` already reports the gap and the accounts on each
 * side. What nothing could do was say what the gap is MADE OF, with the ids of
 * the accounts and journals behind each part. A number with no items has not
 * done the job.
 *
 * WHY THE TWO SIDES ARE INDEPENDENTLY DERIVED. The register side comes from the
 * `assets` table and the ledger side from posted `gl_journal_lines`. Neither is
 * computed from the other, so `difference` can actually be non-zero. An
 * identity where one side is derived from the other is a tautology wearing a
 * check's name, and it has shipped twice in this module already.
 *
 * WHAT THE ITEMS PROVE, AND WHAT THEY DO NOT. Every held asset and every
 * asset-section GL account is reported at its own amount, and the items sum to
 * the difference by arithmetic. That proves the report omitted nothing. It
 * proves NOTHING about whether any item is correctly classified — on
 * Brightsphere every account subtyped `fixed_assets` that carries a balance is
 * a loan or an investment, and the sum closes just as neatly as it would if
 * they were property, plant and equipment. NECESSARY AND NOT SUFFICIENT.
 *
 * NOTHING IS FILTERED OUT. Misclassification is REPORTED as a property of an
 * item (`normalBalanceViolated`), never used to drop one, and never inferred
 * from an account name.
 */

import { getAssetRegister } from './assetRegisterService';
import {
  ASSET_COST_SUBTYPE,
  loadAssetSectionAccounts,
  loadAssetSectionDocuments,
  hasRegisterLinkage,
  type AssetReconcilingDocument,
} from './fixedAssetReconciliationQueries';
import type { ExcludedRow } from '@/lib/mcp/contracts';

export type { AssetReconcilingDocument };

export type AssetItemSide = 'register' | 'ledger';

export interface AssetReconcilingItem {
  side: AssetItemSide;
  type: 'register_asset_carrying_amount' | 'ledger_account_balance';
  /** Contribution to `difference`. The items sum to it exactly. */
  amount: number;
  /** Whether this item could be tied to the other side. */
  attribution: 'linked' | 'unlinked';
  attributedVia: 'asset_gl_account' | 'category_gl_account' | null;
  assetId: string | null;
  assetNumber: string | null;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  accountSubtype: string | null;
  /**
   * A cost account carrying a CREDIT balance, or an accumulated-depreciation
   * account carrying a DEBIT one. Structural and name-free: it is the only
   * honest signal available that an account subtyped into the asset section is
   * not property, plant and equipment. Reported, never acted on.
   */
  normalBalanceViolated: boolean;
  postedLineCount: number;
  detail: string;
}

export interface FixedAssetReconciliation {
  asAt: string;
  registerCost: number;
  registerAccumulatedDepreciation: number;
  registerNetBookValue: number;
  glCost: number;
  glAccumulatedDepreciation: number;
  glNetBookValue: number;
  /** register NBV less GL NBV. */
  difference: number;
  itemsTotal: number;
  /** difference less itemsTotal. Zero means the items account for all of it. */
  unexplainedDifference: number;
  items: AssetReconcilingItem[];
  documents: AssetReconcilingDocument[];
  documentsTotal: number;
  linkedItemCount: number;
  unlinkedItemCount: number;
  contraNormalBalanceCount: number;
  contraNormalBalanceTotal: number;
  /**
   * False when NO asset and no asset category names a GL account, which is the
   * state of every production company: there is then no data by which any part
   * of the ledger could be attributed to the register, and every item is
   * `unlinked` for that reason rather than because a link was checked and
   * failed.
   */
  registerLinkageAvailable: boolean;
  excludedRows: ExcludedRow[];
  postedThrough: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function reconcileFixedAssets(
  companyId: string,
  asOf: string,
): Promise<FixedAssetReconciliation> {
  // SEQUENTIAL, not Promise.all. Every query runs on the request's single
  // pooled client (`withAuth` opens one transaction and the MCP registry runs
  // inside it); issuing them concurrently on one pg client is deprecated and
  // reorders work on a connection that may also be holding a savepoint.
  const accountRows = await loadAssetSectionAccounts(companyId, asOf);
  const documents = await loadAssetSectionDocuments(companyId, asOf);
  const linkageAvailable = await hasRegisterLinkage(companyId);
  // Register side: independently derived from the `assets` table. The high
  // limit is deliberate — the totals this reconciliation compares must cover
  // every asset, not a page of them.
  const register = await getAssetRegister(companyId, asOf, { limit: 5000, offset: 0 });

  const items: AssetReconcilingItem[] = [];

  // Register side. Each held asset contributes its own carrying amount to the
  // difference, positively, and carries the asset id so a reader can follow it
  // with list_fixed_assets.
  for (const a of register.rows) {
    items.push({
      side: 'register',
      type: 'register_asset_carrying_amount',
      amount: round2(a.netBookValue),
      attribution: 'unlinked',
      attributedVia: null,
      assetId: a.id,
      assetNumber: a.assetNumber,
      accountId: null,
      accountCode: null,
      accountName: null,
      accountSubtype: null,
      normalBalanceViolated: false,
      postedLineCount: 0,
      detail:
        `Register carrying amount ${a.netBookValue.toFixed(2)} `
        + `(cost ${a.purchasePrice.toFixed(2)} less accumulated depreciation `
        + `${a.accumulatedDepreciation.toFixed(2)}). No GL account is recorded against it.`,
    });
  }

  // Ledger side. glNetBookValue is the SUM of these balances, so each one
  // contributes the NEGATIVE of its balance to `register − GL`.
  let glCost = 0;
  let glAccumulatedDepreciation = 0;
  for (const r of accountRows) {
    const balance = round2(Number(r.balance) || 0);
    const subtype = String(r.account_subtype ?? '');
    if (subtype === ASSET_COST_SUBTYPE) glCost = round2(glCost + balance);
    else glAccumulatedDepreciation = round2(glAccumulatedDepreciation + balance);

    const violated = subtype === ASSET_COST_SUBTYPE ? balance < 0 : balance > 0;

    items.push({
      side: 'ledger',
      type: 'ledger_account_balance',
      amount: round2(-balance),
      attribution: 'unlinked',
      attributedVia: null,
      assetId: null,
      assetNumber: null,
      accountId: String(r.id),
      accountCode: String(r.account_code ?? ''),
      accountName: String(r.account_name ?? ''),
      accountSubtype: subtype,
      normalBalanceViolated: violated,
      postedLineCount: Number(r.posted_lines) || 0,
      detail:
        `GL balance ${balance.toFixed(2)} on an account subtyped ${subtype}`
        + (violated
          ? ' — the sign is opposite to the one this subtype implies, so the'
            + ' account is unlikely to be property, plant and equipment.'
          : '.'),
    });
  }

  const postedThrough = accountRows
    .map((r) => (r.posted_through ? new Date(String(r.posted_through)).toISOString() : null))
    .filter((v): v is string => v !== null)
    .sort()
    .slice(-1)[0] ?? null;

  const glNetBookValue = round2(glCost + glAccumulatedDepreciation);
  const difference = round2(register.totals.netBookValue - glNetBookValue);
  const itemsTotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const violating = items.filter((i) => i.normalBalanceViolated);

  const excludedRows: ExcludedRow[] = register.disposed.map((a) => ({
    id: a.id,
    reason: 'disposed_before_as_at',
    detail:
      `Disposed on ${a.disposalDate}`
      + (a.disposalAmount === null ? '' : ` for ${a.disposalAmount.toFixed(2)}`)
      + `; not carrying amount at ${asOf}.`,
    amount: a.netBookValue,
    documentNumber: a.assetNumber,
  }));

  return {
    asAt: asOf,
    registerCost: register.totals.cost,
    registerAccumulatedDepreciation: register.totals.accumulatedDepreciation,
    registerNetBookValue: register.totals.netBookValue,
    glCost,
    glAccumulatedDepreciation,
    glNetBookValue,
    difference,
    itemsTotal,
    unexplainedDifference: round2(difference - itemsTotal),
    items,
    documents,
    documentsTotal: documents.length,
    linkedItemCount: items.filter((i) => i.attribution === 'linked').length,
    unlinkedItemCount: items.filter((i) => i.attribution === 'unlinked').length,
    contraNormalBalanceCount: violating.length,
    // Reported as the BALANCES that violate, not as their contributions to the
    // difference: a reader comparing this to the chart of accounts wants the
    // sign the ledger carries.
    contraNormalBalanceTotal: round2(
      violating.reduce((s, i) => s + (i.side === 'ledger' ? -i.amount : i.amount), 0),
    ),
    registerLinkageAvailable: linkageAvailable,
    excludedRows,
    postedThrough,
  };
}
