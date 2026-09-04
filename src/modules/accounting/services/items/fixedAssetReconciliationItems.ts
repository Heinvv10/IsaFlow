/**
 * The ROWS of the fixed asset reconciliation: one item per held asset, one per
 * asset-section GL account, plus the two things that are reported beside the
 * arithmetic rather than inside it.
 *
 * Split from `fixedAssetReconciliationService.ts` to keep both files inside the
 * 300-line cap. The reasoning that governs them lives there.
 */

import type { AssetRegisterRow } from './assetRegisterService';
import { ASSET_COST_SUBTYPE } from './fixedAssetReconciliationQueries';
import type { UnpostedDisposal } from './fixedAssetDisposalQueries';
import type { DbRow } from '@/lib/neon';
import type { ExcludedRow } from '@/lib/mcp/contracts';

export type AssetItemSide = 'register' | 'ledger';

export interface AssetReconcilingItem {
  side: AssetItemSide;
  type: 'register_asset_carrying_amount' | 'ledger_account_balance';
  /** Contribution to `difference`. The items sum to it exactly. */
  amount: number;
  //
  // THERE IS NO PER-ITEM `attribution` FIELD, deliberately.
  //
  // There used to be — `attribution: 'linked' | 'unlinked'` with an
  // `attributedVia` beside it — and both were hardcoded `'unlinked'` / `null`
  // at every construction site, unconditionally. The type promised a decision
  // the code never made, `linkedItemCount` was dead at zero forever, and the
  // tool description explained WHY an item was unlinked as though a check had
  // run. Nothing in this schema could have computed it: no asset and no asset
  // category in production records a GL account, so there is no data by which
  // any item could be tied to the other side.
  //
  // `registerLinkageAvailable` carries that fact instead, from a real query, as
  // ONE statement about the company rather than a per-row claim repeated for
  // every item. A field that can only ever hold one value is not information,
  // and a type that says otherwise is a promise the reader will act on.
  //
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

/** A fact about data this reconciliation could NOT draw from. */
export interface AssetDisclosure {
  accountId: string;
  accountCode: string;
  accountName: string;
  isActive: boolean;
  balance: number;
  reason: 'no_account_subtype';
  detail: string;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Each held asset contributes its own carrying amount to the difference,
 * positively, and carries the asset id so a reader can follow it with
 * list_fixed_assets.
 */
export function buildRegisterItems(rows: readonly AssetRegisterRow[]): AssetReconcilingItem[] {
  return rows.map((a) => ({
    side: 'register' as const,
    type: 'register_asset_carrying_amount' as const,
    amount: round2(a.netBookValue),
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
  }));
}

/**
 * `glNetBookValue` is the SUM of these balances, so each account contributes
 * the NEGATIVE of its balance to `register - GL`.
 */
export function buildLedgerItems(accountRows: readonly DbRow[]): {
  items: AssetReconcilingItem[];
  glCost: number;
  glAccumulatedDepreciation: number;
} {
  const items: AssetReconcilingItem[] = [];
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
  return { items, glCost, glAccumulatedDepreciation };
}

/** Reported OUTSIDE the completeness identity — see the service's own note. */
export function buildDisclosures(unsubtyped: readonly DbRow[]): AssetDisclosure[] {
  return unsubtyped.map((r) => ({
    accountId: String(r.id),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    isActive: r.is_active !== false,
    balance: round2(Number(r.balance) || 0),
    reason: 'no_account_subtype' as const,
    detail:
      `Account ${String(r.account_code ?? '')} "${String(r.account_name ?? '')}" is typed asset `
      + 'but carries no account_subtype, so it is in neither side of this reconciliation and its '
      + 'balance can never make the difference non-zero. Set its subtype with update_gl_account '
      + 'if it is property, plant and equipment.',
  }));
}

/**
 * A disposal that never posted gets its OWN reason code.
 *
 * Both rows are exclusions — the asset was in the register's universe and was
 * withheld from the totals — but a caller branching on `reason` has to be able
 * to tell "sold and accounted for" from "sold, and the ledger never heard".
 */
export function buildExcludedRows(
  disposed: readonly AssetRegisterRow[],
  unposted: readonly UnpostedDisposal[],
  asOf: string,
): ExcludedRow[] {
  const unpostedById = new Map(unposted.map((d) => [d.assetId, d]));
  return disposed.map((a) => {
    const d = unpostedById.get(a.id);
    const sold =
      `Disposed on ${a.disposalDate}`
      + (a.disposalAmount === null ? '' : ` for ${a.disposalAmount.toFixed(2)}`);
    return {
      id: a.id,
      reason: d ? 'disposal_not_posted_to_ledger' : 'disposed_before_as_at',
      detail: d
        ? `${sold}; NO journal was ever posted for it`
          + (d.gainLoss === null
            ? ''
            : `, so a ${d.gainLoss < 0 ? 'loss' : 'gain'} of ${Math.abs(d.gainLoss).toFixed(2)}`
              + ' is on the register and not in the ledger')
          + (d.disposalRecordMissing ? ', and no asset_disposals record exists at all' : '')
          + '. This cannot move the difference: the asset is out of the register\'s carrying'
          + ' amount and the journal is absent from the ledger, so both sides are zero.'
        : `${sold}; not carrying amount at ${asOf}.`,
      amount: a.netBookValue,
      documentNumber: a.assetNumber,
    };
  });
}
