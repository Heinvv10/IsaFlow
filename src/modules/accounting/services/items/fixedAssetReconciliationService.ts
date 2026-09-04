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
  loadAssetSectionAccounts,
  loadUnsubtypedAssetAccounts,
  loadUnpostedDisposals,
  type UnpostedDisposal,
  loadAssetSectionDocuments,
  hasRegisterLinkage,
  type AssetReconcilingDocument,
} from './fixedAssetReconciliationQueries';
import type { ExcludedRow } from '@/lib/mcp/contracts';
import {
  buildRegisterItems,
  buildLedgerItems,
  buildDisclosures,
  buildExcludedRows,
  round2,
  type AssetDisclosure,
  type AssetItemSide,
  type AssetReconcilingItem,
} from './fixedAssetReconciliationItems';

export type { AssetReconcilingDocument, UnpostedDisposal };
export type { AssetDisclosure, AssetItemSide, AssetReconcilingItem };

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
  /**
   * Asset-typed GL accounts carrying NO subtype.
   *
   * They are a DISCLOSURE, not an exclusion, and the distinction is the
   * contract's own: an exclusion is a row that belonged to this report's
   * universe and was withheld from the totals, whereas these were never in it —
   * the universe is defined by subtype and they have none. Putting them in
   * `excludedRows` would also drown the signal: Velocity Fibre has 58 such
   * accounts holding a net R32,747,547.38 between them, and most are debtors
   * and cash rather than property, plant and equipment. Reporting that as
   * "R32.7m the fixed asset reconciliation could not classify" would be true in
   * magnitude and wrong in kind.
   *
   * What they ARE is the reason a zero difference can mean nothing: any one of
   * them that IS property, plant and equipment is missing from the GL side, and
   * because the items and the totals come from the same subtype-filtered query,
   * its balance could never make the residual non-zero. This report cannot tell
   * which — nothing here is inferred from an account NAME — so it names them
   * all and lets the reader look.
   */
  unsubtypedAccounts: AssetDisclosure[];
  unsubtypedAccountCount: number;
  unsubtypedAccountBalance: number;
  /**
   * Disposals the register recorded that never reached the ledger.
   *
   * The one register-versus-ledger break that can never move `difference`: a
   * disposed asset is correctly out of the register's carrying amount and an
   * unposted disposal is correctly absent from the ledger, so both sides are
   * zero and the arithmetic closes over a real recorded loss. Brightsphere's
   * R7,000 on COMP-0001 is exactly that, and it cannot post on any tenant
   * because no company has a `disposal_profit_loss` account.
   */
  unpostedDisposals: UnpostedDisposal[];
  unpostedDisposalCount: number;
  /** Profit or loss on disposal that never reached the income statement. */
  unpostedDisposalGainLoss: number;
  /** Cost less depreciation that was never removed from the balance sheet. */
  unpostedDisposalBookValue: number;
  excludedRows: ExcludedRow[];
  postedThrough: string | null;
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
  const unsubtyped = await loadUnsubtypedAssetAccounts(companyId, asOf);
  const unposted = await loadUnpostedDisposals(companyId, asOf);
  const linkageAvailable = await hasRegisterLinkage(companyId);
  // Register side: independently derived from the `assets` table. The high
  // limit is deliberate — the totals this reconciliation compares must cover
  // every asset, not a page of them.
  const register = await getAssetRegister(companyId, asOf, { limit: 5000, offset: 0 });

  const registerItems = buildRegisterItems(register.rows);
  const ledger = buildLedgerItems(accountRows);
  const items = [...registerItems, ...ledger.items];
  const { glCost, glAccumulatedDepreciation } = ledger;

  const postedThrough = accountRows
    .map((r) => (r.posted_through ? new Date(String(r.posted_through)).toISOString() : null))
    .filter((v): v is string => v !== null)
    .sort()
    .slice(-1)[0] ?? null;

  const glNetBookValue = round2(glCost + glAccumulatedDepreciation);
  const difference = round2(register.totals.netBookValue - glNetBookValue);
  const itemsTotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const violating = items.filter((i) => i.normalBalanceViolated);

  const unsubtypedAccounts = buildDisclosures(unsubtyped);
  const excludedRows = buildExcludedRows(register.disposed, unposted, asOf);

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
    unsubtypedAccounts,
    unsubtypedAccountCount: unsubtypedAccounts.length,
    unsubtypedAccountBalance: round2(
      unsubtypedAccounts.reduce((t, d) => t + d.balance, 0),
    ),
    unpostedDisposals: unposted,
    unpostedDisposalCount: unposted.length,
    unpostedDisposalGainLoss: round2(
      unposted.reduce((t, d) => t + (d.gainLoss ?? 0), 0),
    ),
    unpostedDisposalBookValue: round2(
      unposted.reduce((t, d) => t + (d.bookValueAtDisposal ?? 0), 0),
    ),
    excludedRows,
    postedThrough,
  };
}
