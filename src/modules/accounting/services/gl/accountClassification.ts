/**
 * Financial figures folded out of GL movement, classified by `account_type`
 * and canonical `account_subtype` — never by `account_code`.
 *
 * See ./accountSubtypes.ts for why account_code is unusable and how the
 * subtype vocabulary is canonicalised. This file is the aggregation layer every
 * report endpoint calls instead of hand-rolling a CASE over code prefixes.
 */

import {
  type AccountType,
  type CanonicalSubtype,
  canonicalSubtype,
  isCurrentSubtype,
} from './accountSubtypes';

export {
  type AccountType,
  type CanonicalSubtype,
  canonicalSubtype,
  isCurrentSubtype,
  isCashEquivalent,
  rawSubtypesFor,
  CASH_SUBTYPES,
  INVENTORY_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  PAYABLE_SUBTYPES,
  INVESTING_ASSET_SUBTYPES,
} from './accountSubtypes';

/** One `GROUP BY account_type, account_subtype` row of debit/credit movement. */
export interface ClassificationRow {
  account_type: AccountType;
  account_subtype: string | null;
  debit: number | string | null;
  credit: number | string | null;
  /** Number of GL accounts behind this group. Defaults to 1. */
  account_count?: number | string | null;
}

export interface ClassifiedFigures {
  revenue: number;
  otherIncome: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  otherExpenses: number;
  depreciation: number;
  netProfit: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentAssets: number;
  nonCurrentAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
  cash: number;
  accountsReceivable: number;
  accountsPayable: number;
  inventory: number;
  /** GL accounts whose subtype was NULL or unrecognised, so a default was applied. */
  unclassifiedCount: number;
  /** Signed balance carried by those accounts. */
  unclassifiedTotal: number;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

const zero = (): ClassifiedFigures => ({
  revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0,
  operatingExpenses: 0, otherExpenses: 0, depreciation: 0, netProfit: 0,
  totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
  currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
  cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
  unclassifiedCount: 0, unclassifiedTotal: 0,
});

/** Expense subtypes reported below the operating line. */
const OTHER_EXPENSE: ReadonlySet<CanonicalSubtype> = new Set<CanonicalSubtype>([
  'finance_cost',
  'tax_expense',
  'other_expense',
]);

/**
 * Fold `GROUP BY account_type, account_subtype` movement into the figures every
 * report needs. Signs follow normal balance: debit-credit for assets and
 * expenses, credit-debit for liabilities, equity and revenue.
 */
export function aggregateFigures(rows: readonly ClassificationRow[]): ClassifiedFigures {
  const f = zero();

  for (const r of rows) {
    const debit = num(r.debit);
    const credit = num(r.credit);
    const count = r.account_count == null ? 1 : num(r.account_count);
    const canon = canonicalSubtype(r.account_subtype);
    const type = r.account_type;
    const balance =
      type === 'asset' || type === 'expense' ? debit - credit : credit - debit;

    if (canon === null && (type === 'asset' || type === 'liability')) {
      f.unclassifiedCount += count;
      f.unclassifiedTotal += balance;
    }

    switch (type) {
      case 'asset':
        f.totalAssets += balance;
        if (isCurrentSubtype(type, r.account_subtype)) f.currentAssets += balance;
        else f.nonCurrentAssets += balance;
        if (canon === 'bank' || canon === 'cash') f.cash += balance;
        if (canon === 'receivable') f.accountsReceivable += balance;
        if (canon === 'inventory') f.inventory += balance;
        break;
      case 'liability':
        f.totalLiabilities += balance;
        if (isCurrentSubtype(type, r.account_subtype)) f.currentLiabilities += balance;
        else f.nonCurrentLiabilities += balance;
        if (canon === 'payable') f.accountsPayable += balance;
        break;
      case 'equity':
        f.totalEquity += balance;
        break;
      case 'revenue':
        if (canon === 'other_income') f.otherIncome += balance;
        else f.revenue += balance;
        break;
      case 'expense':
        if (canon === 'cost_of_sales') f.costOfSales += balance;
        else if (canon !== null && OTHER_EXPENSE.has(canon)) f.otherExpenses += balance;
        else f.operatingExpenses += balance;
        if (canon === 'depreciation_expense') f.depreciation += balance;
        break;
    }
  }

  f.grossProfit = f.revenue - f.costOfSales;
  f.netProfit =
    f.revenue + f.otherIncome - f.costOfSales - f.operatingExpenses - f.otherExpenses;
  return f;
}
