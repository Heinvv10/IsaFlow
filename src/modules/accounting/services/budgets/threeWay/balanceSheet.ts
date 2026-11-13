/**
 * Balance-sheet sections from debit-positive buckets (P6 spec §5 Output).
 * Natural sign: assets +, liabilities and equity as credit balances +.
 * `vatControl` sits with current assets when it is a debit, else with current
 * liabilities; negative cash stays a (negative) current asset — shown, never
 * re-classed as an overdraft (10d). `loans` (current portion included) is
 * non-current.
 */
import { BUCKET_KEYS, type BalanceSheetSections, type Buckets } from './types';

export function balanceSheetSections(b: Buckets): BalanceSheetSections {
  const vatAsset = Math.max(b.vatControl, 0);
  const vatLiability = Math.min(b.vatControl, 0);
  const currentAssets = b.cash + b.receivables + b.inventory + vatAsset + b.otherCurrentAssets;
  const nonCurrentAssets = b.fixedAssets + b.accumDepreciation + b.otherNonCurrentAssets;
  const currentLiabilities = -(b.payables + b.payrollLiabilities + b.incomeTaxPayable + b.dividendsPayable
    + vatLiability + b.otherCurrentLiabilities);
  const nonCurrentLiabilities = -(b.loans + b.otherNonCurrentLiabilities);
  const equity = -(b.shareCapital + b.otherEquity + b.retainedEarnings);
  const totalAssets = currentAssets + nonCurrentAssets;
  const totalLiabilities = currentLiabilities + nonCurrentLiabilities;
  return {
    currentAssets, nonCurrentAssets, totalAssets,
    currentLiabilities, nonCurrentLiabilities, totalLiabilities,
    equity, check: totalAssets - totalLiabilities - equity,
  };
}

/** Σ of every debit-positive bucket: 0 exactly when the balance sheet balances. */
export function bucketSum(b: Buckets): number {
  return BUCKET_KEYS.reduce((s, k) => s + b[k], 0);
}
