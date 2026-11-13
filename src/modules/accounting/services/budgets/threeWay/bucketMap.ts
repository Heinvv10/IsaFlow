/**
 * Which balance-sheet bucket an account's opening balance lands in, and which
 * engine P&L band a budget line feeds (P6 spec §5 Buckets, §13 items 6 and 10).
 * PURE: the DB readers (`openingBalances.ts`, `versionPnl.ts`,
 * `actualsLookback.ts`) call it per row.
 *
 * Buckets go by `account_type` and CANONICAL subtype (`canonicalSubtype`), never
 * by account code. A subtype claims an account only on its own side (an asset
 * spelled `payable` is not a payable). Exceptions, in order:
 *   - a loan's `gl_account_id` / `current_portion_account_id` is `loans`;
 *   - the system retained-earnings account is `retainedEarnings` (derived RE is
 *     added to it, as `getBalanceSheet` adds it to the system RE line);
 *   - a liability spelled bank/cash is a credit card (`otherCurrentLiabilities`);
 *   - `vat_input` / `vat_output` net in `vatControl` on either side;
 *   - `vat_input_late_claim` and `eti_refund_receivable` are other current assets.
 * Anything else no rule claims is `mapped: false` (current by default, as
 * `isCurrentSubtype` defaults) and the engine warns when it carries a balance.
 * Income-tax and dividends payable have no subtype: they are the engine's
 * synthetic lines (opening 0).
 */
import { canonicalSubtype, type CanonicalSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import type { BucketKey, PnlBand } from './types';

export type BalanceSheetType = 'asset' | 'liability' | 'equity';

export interface BucketFlags {
  /** The account is some loan's `gl_account_id` or `current_portion_account_id`. */
  isLoanAccount: boolean;
  /** The account is the company's system retained-earnings account. */
  isRetainedEarningsAccount: boolean;
}

export interface BucketChoice {
  bucket: BucketKey;
  /** False when no rule claimed the account (warned by the engine when its balance is not 0). */
  mapped: boolean;
}

const ASSET: Partial<Record<CanonicalSubtype, BucketKey>> = {
  bank: 'cash',
  cash: 'cash',
  receivable: 'receivables',
  inventory: 'inventory',
  vat_input: 'vatControl',
  vat_output: 'vatControl',
  fixed_asset: 'fixedAssets',
  accumulated_depreciation: 'accumDepreciation',
  prepaid_expense: 'otherCurrentAssets',
  current_asset: 'otherCurrentAssets',
  other_current_asset: 'otherCurrentAssets',
  vat_input_late_claim: 'otherCurrentAssets',
  eti_refund_receivable: 'otherCurrentAssets',
  intangible_asset: 'otherNonCurrentAssets',
  investment: 'otherNonCurrentAssets',
  non_current_asset: 'otherNonCurrentAssets',
};

const LIABILITY: Partial<Record<CanonicalSubtype, BucketKey>> = {
  payable: 'payables',
  payroll_liability: 'payrollLiabilities',
  vat_output: 'vatControl',
  vat_input: 'vatControl',
  long_term_liability: 'loans',
  non_current_liability: 'loans',
  credit_card: 'otherCurrentLiabilities',
  // A liability spelled bank/cash is a credit card (§13.10): financing, never cash.
  bank: 'otherCurrentLiabilities',
  cash: 'otherCurrentLiabilities',
  current_liability: 'otherCurrentLiabilities',
  other_current_liability: 'otherCurrentLiabilities',
};

const EQUITY: Partial<Record<CanonicalSubtype, BucketKey>> = {
  // `share_capital` and `owners_equity` canonicalise to `equity`: contributed capital.
  equity: 'shareCapital',
  retained_earnings: 'retainedEarnings',
  // Dividends declared close to retained earnings (the engine debits RE on declaration).
  dividends: 'retainedEarnings',
  opening_balance_equity: 'otherEquity',
};

const TABLE: Record<BalanceSheetType, Partial<Record<CanonicalSubtype, BucketKey>>> = { asset: ASSET, liability: LIABILITY, equity: EQUITY };
const UNMAPPED: Record<BalanceSheetType, BucketKey> = {
  asset: 'otherCurrentAssets', liability: 'otherCurrentLiabilities', equity: 'otherEquity',
};

export function bucketOf(accountType: BalanceSheetType, subtype: string | null | undefined, flags: BucketFlags): BucketChoice {
  if (!(accountType in TABLE)) throw new RangeError(`Not a balance-sheet account type: ${String(accountType)}`);
  if (flags.isLoanAccount && accountType === 'liability') return { bucket: 'loans', mapped: true };
  if (flags.isRetainedEarningsAccount && accountType === 'equity') return { bucket: 'retainedEarnings', mapped: true };
  const canon = canonicalSubtype(subtype);
  const bucket = canon === null ? undefined : TABLE[accountType][canon];
  return bucket ? { bucket, mapped: true } : { bucket: UNMAPPED[accountType], mapped: false };
}

const EXPENSE: Partial<Record<CanonicalSubtype, PnlBand>> = {
  cost_of_sales: 'costOfSales',
  payroll_expense: 'payroll',
  depreciation_expense: 'depreciation',
  finance_cost: 'financeCost',
  tax_expense: 'taxExpense',
};

/**
 * The engine band of a revenue or expense line. Revenue follows the grid's
 * `revenueBand` (only `other_income` is other income; everything else, a missing
 * subtype included, is turnover); expenses split by canonical subtype, the rest
 * is other opex (supplier-paid).
 */
export function pnlBandOf(accountType: 'revenue' | 'expense', subtype: string | null | undefined): PnlBand {
  const canon = canonicalSubtype(subtype);
  if (accountType === 'revenue') return canon === 'other_income' ? 'otherIncome' : 'turnover';
  return (canon === null ? undefined : EXPENSE[canon]) ?? 'otherOpex';
}

/** Liability subtypes that are a bank facility, never a payable slot (a liability spelled bank/cash is a card). */
const NOT_A_PAYABLE: ReadonlySet<CanonicalSubtype> = new Set<CanonicalSubtype>(['credit_card', 'bank', 'cash']);

/**
 * May this liability be named as income-tax or dividends payable (review R1)? Only one whose balance
 * would otherwise sit in other (current or non-current) liabilities, and which is no loan's account:
 * never AP control, VAT control, a payroll liability, a loan or a credit card. Moving a typed control
 * account would empty its own bucket and drive the wrong cash flows.
 */
export function payableSlotAllowed(subtype: string | null | undefined, isLoanAccount: boolean): boolean {
  if (isLoanAccount) return false;
  const canon = canonicalSubtype(subtype);
  if (canon !== null && NOT_A_PAYABLE.has(canon)) return false;
  const { bucket } = bucketOf('liability', subtype, { isLoanAccount: false, isRetainedEarningsAccount: false });
  return bucket === 'otherCurrentLiabilities' || bucket === 'otherNonCurrentLiabilities';
}
