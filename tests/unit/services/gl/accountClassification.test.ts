/**
 * Unit tests for the shared GL account classification resolver.
 *
 * Background (reporting audit P0): ~12 report endpoints classified GL accounts
 * by parsing `account_code` as a string — `LIKE '1%'` for assets, `>= '4000'`
 * for revenue, `= '1110'` for cash. Production data does not support that at
 * all. On Velocity Fibre, code prefix `4` spans assets, liabilities, equity,
 * revenue AND expenses; Sage-imported charts use alphabetic prefixes entirely.
 * Measured damage: total assets R56.3m against a true R89.1m, revenue R34.7m
 * against R99.5m, operating expenses NEGATIVE R80,880, and 85 bank accounts
 * hidden because "cash" meant `account_code = '1110'`.
 *
 * `account_type` is NOT NULL and CHECK-constrained to the five buckets, so it
 * is authoritative. `account_subtype` is free-form and full of duplicate
 * singular/plural spellings, so it must be canonicalised before use.
 *
 * Pure functions — no DB connection required.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalSubtype,
  isCurrentSubtype,
  isCashEquivalent,
  aggregateFigures,
  rawSubtypesFor,
  CASH_SUBTYPES,
  type ClassificationRow,
} from '@/modules/accounting/services/gl/accountClassification';

/**
 * The live vocabulary, taken from
 *   SELECT account_type, account_subtype, count(*) FROM gl_accounts GROUP BY 1,2
 * run against both the production (`isaflow`) and dev (`isaflow_dev`) databases
 * on 2026-09-03. Every one of these must resolve — a new spelling appearing in
 * production without a mapping is exactly the failure this table guards.
 */
const LIVE_VOCABULARY: Array<[string, string]> = [
  ['asset', 'accumulated_depreciation'],
  ['asset', 'bank'],
  ['asset', 'cash'],
  ['asset', 'current_assets'],
  ['asset', 'fixed_asset'],
  ['asset', 'fixed_assets'],
  ['asset', 'other_current_asset'],
  ['asset', 'receivable'],
  ['asset', 'vat_input'],
  ['equity', 'equity'],
  ['equity', 'opening_balance_equity'],
  ['equity', 'retained_earnings'],
  ['expense', 'admin_expense'],
  ['expense', 'cost_of_sales'],
  ['expense', 'default_expense'],
  ['expense', 'depreciation_expense'],
  ['expense', 'finance_cost'],
  ['expense', 'insurance_expense'],
  ['expense', 'operating_expense'],
  ['expense', 'operating_expenses'],
  ['expense', 'tax'],
  ['liability', 'current_liabilities'],
  ['liability', 'current_liability'],
  ['liability', 'long_term_liabilities'],
  ['liability', 'long_term_liability'],
  ['liability', 'other_current_liability'],
  ['liability', 'payable'],
  ['liability', 'payroll_liability'],
  ['liability', 'vat_output'],
  ['revenue', 'default_revenue'],
  ['revenue', 'other_income'],
  ['revenue', 'revenue'],
  ['revenue', 'sales'],
];

function row(
  accountType: ClassificationRow['account_type'],
  accountSubtype: string | null,
  debit: number,
  credit: number,
  accountCount = 1
): ClassificationRow {
  return {
    account_type: accountType,
    account_subtype: accountSubtype,
    debit,
    credit,
    account_count: accountCount,
  };
}

describe('canonicalSubtype', () => {
  it('collapses the duplicate plural spellings onto one canonical token', () => {
    expect(canonicalSubtype('fixed_assets')).toBe('fixed_asset');
    expect(canonicalSubtype('fixed_asset')).toBe('fixed_asset');
    expect(canonicalSubtype('operating_expenses')).toBe('operating_expense');
    expect(canonicalSubtype('operating_expense')).toBe('operating_expense');
    expect(canonicalSubtype('current_liabilities')).toBe('current_liability');
    expect(canonicalSubtype('current_liability')).toBe('current_liability');
    expect(canonicalSubtype('long_term_liabilities')).toBe('long_term_liability');
    expect(canonicalSubtype('long_term_liability')).toBe('long_term_liability');
    expect(canonicalSubtype('current_assets')).toBe('current_asset');
  });

  it('maps importer-specific spellings onto the canonical vocabulary', () => {
    expect(canonicalSubtype('default_expense')).toBe('operating_expense');
    expect(canonicalSubtype('default_revenue')).toBe('revenue');
    expect(canonicalSubtype('tax')).toBe('tax_expense');
  });

  it('normalises case, whitespace and hyphens before matching', () => {
    expect(canonicalSubtype('  Fixed Assets  ')).toBe('fixed_asset');
    expect(canonicalSubtype('COST-OF-SALES')).toBe('cost_of_sales');
  });

  it('returns null for absent or ambiguous subtypes rather than guessing', () => {
    expect(canonicalSubtype(null)).toBeNull();
    expect(canonicalSubtype(undefined)).toBeNull();
    expect(canonicalSubtype('')).toBeNull();
    // 'other' exists in production on both expenses and liabilities and says
    // nothing about currency or bucket. Guessing here is what the audit found.
    expect(canonicalSubtype('other')).toBeNull();
    expect(canonicalSubtype('wibble')).toBeNull();
  });

  it.each(LIVE_VOCABULARY)(
    'resolves the live production subtype %s/%s',
    (_type, subtype) => {
      expect(canonicalSubtype(subtype)).not.toBeNull();
    }
  );
});

describe('isCurrentSubtype', () => {
  it('treats fixed and long-term subtypes as non-current', () => {
    expect(isCurrentSubtype('asset', 'fixed_asset')).toBe(false);
    expect(isCurrentSubtype('asset', 'accumulated_depreciation')).toBe(false);
    expect(isCurrentSubtype('liability', 'long_term_liability')).toBe(false);
  });

  it('treats bank, cash, receivable and payable as current', () => {
    expect(isCurrentSubtype('asset', 'bank')).toBe(true);
    expect(isCurrentSubtype('asset', 'cash')).toBe(true);
    expect(isCurrentSubtype('asset', 'receivable')).toBe(true);
    expect(isCurrentSubtype('liability', 'payable')).toBe(true);
    expect(isCurrentSubtype('liability', 'payroll_liability')).toBe(true);
  });

  it('defaults unknown and NULL asset/liability subtypes to current', () => {
    expect(isCurrentSubtype('asset', null)).toBe(true);
    expect(isCurrentSubtype('liability', null)).toBe(true);
  });

  it('is false for buckets where currency is meaningless', () => {
    expect(isCurrentSubtype('revenue', 'revenue')).toBe(false);
    expect(isCurrentSubtype('expense', 'operating_expense')).toBe(false);
    expect(isCurrentSubtype('equity', 'equity')).toBe(false);
  });
});

describe('isCashEquivalent', () => {
  it('accepts bank and cash subtypes only', () => {
    expect(isCashEquivalent('asset', 'bank')).toBe(true);
    expect(isCashEquivalent('asset', 'cash')).toBe(true);
    expect(isCashEquivalent('asset', 'receivable')).toBe(false);
    expect(isCashEquivalent('asset', 'fixed_asset')).toBe(false);
    expect(isCashEquivalent('asset', null)).toBe(false);
  });

  it('does not treat a bank subtype on a non-asset as cash', () => {
    expect(isCashEquivalent('liability', 'bank')).toBe(false);
  });
});

describe('aggregateFigures', () => {
  it('buckets by account_type, never by account code prefix', () => {
    // The exact shape production breaks on: expense accounts numbered in the
    // 4000s. Code-prefix classification counted these as revenue, which is how
    // operating expenses came out negative.
    const figures = aggregateFigures([
      row('revenue', 'sales', 0, 100_000),
      row('expense', 'operating_expense', 30_000, 0),
    ]);
    expect(figures.revenue).toBe(100_000);
    expect(figures.operatingExpenses).toBe(30_000);
  });

  it('applies the normal-balance sign per bucket', () => {
    const figures = aggregateFigures([
      row('asset', 'bank', 500, 200),
      row('liability', 'payable', 50, 300),
      row('equity', 'equity', 0, 1_000),
      row('revenue', 'revenue', 100, 900),
      row('expense', 'operating_expense', 700, 100),
    ]);
    expect(figures.totalAssets).toBe(300);
    expect(figures.totalLiabilities).toBe(250);
    expect(figures.totalEquity).toBe(1_000);
    expect(figures.revenue).toBe(800);
    expect(figures.operatingExpenses).toBe(600);
  });

  it('reads cost of sales off the expense bucket, not a phantom account_type', () => {
    // reports-ratios.ts filtered `account_type = 'cost_of_sales'`, a value the
    // CHECK constraint forbids, so cost of sales was always 0 and gross margin
    // always 100%.
    const figures = aggregateFigures([
      row('revenue', 'sales', 0, 100_000),
      row('expense', 'cost_of_sales', 40_000, 0),
      row('expense', 'operating_expense', 10_000, 0),
    ]);
    expect(figures.costOfSales).toBe(40_000);
    expect(figures.operatingExpenses).toBe(10_000);
    expect(figures.grossProfit).toBe(60_000);
    expect(figures.netProfit).toBe(50_000);
  });

  it('separates other income and other expenses from trading results', () => {
    const figures = aggregateFigures([
      row('revenue', 'sales', 0, 100_000),
      row('revenue', 'other_income', 0, 5_000),
      row('expense', 'finance_cost', 2_000, 0),
      row('expense', 'tax', 1_000, 0),
      row('expense', 'operating_expense', 20_000, 0),
    ]);
    expect(figures.revenue).toBe(100_000);
    expect(figures.otherIncome).toBe(5_000);
    expect(figures.otherExpenses).toBe(3_000);
    expect(figures.operatingExpenses).toBe(20_000);
    expect(figures.netProfit).toBe(82_000);
  });

  it('sums cash from every bank and cash account, whatever the code', () => {
    const figures = aggregateFigures([
      row('asset', 'bank', 10_000, 0, 85),
      row('asset', 'cash', 500, 0, 9),
      row('asset', 'receivable', 7_000, 0),
    ]);
    expect(figures.cash).toBe(10_500);
    expect(figures.accountsReceivable).toBe(7_000);
  });

  it('splits current from non-current using the canonical subtype', () => {
    const figures = aggregateFigures([
      row('asset', 'bank', 1_000, 0),
      row('asset', 'fixed_asset', 9_000, 0),
      row('asset', 'accumulated_depreciation', 0, 2_000),
      row('liability', 'payable', 0, 400),
      row('liability', 'long_term_liability', 0, 6_000),
    ]);
    expect(figures.totalAssets).toBe(8_000);
    expect(figures.currentAssets).toBe(1_000);
    expect(figures.nonCurrentAssets).toBe(7_000);
    expect(figures.currentLiabilities).toBe(400);
    expect(figures.nonCurrentLiabilities).toBe(6_000);
  });

  it('defaults unknown asset/liability subtypes to current AND reports them', () => {
    // 344 production accounts carry a NULL subtype. Folding them in silently is
    // the failure mode this audit exists to stop, so callers must be able to
    // see how much of the balance sheet is a default rather than a fact.
    const figures = aggregateFigures([
      row('asset', 'bank', 1_000, 0),
      row('asset', null, 4_000, 0, 102),
      row('liability', 'other', 0, 250, 3),
    ]);
    expect(figures.currentAssets).toBe(5_000);
    expect(figures.currentLiabilities).toBe(250);
    expect(figures.unclassifiedCount).toBe(105);
    expect(figures.unclassifiedTotal).toBe(4_250);
  });

  it('does not count classified accounts as unclassified', () => {
    const figures = aggregateFigures([
      row('asset', 'bank', 1_000, 0, 85),
      row('expense', 'operating_expenses', 500, 0, 39),
    ]);
    expect(figures.unclassifiedCount).toBe(0);
    expect(figures.unclassifiedTotal).toBe(0);
  });

  it('accepts numeric strings, which is what pg returns for NUMERIC columns', () => {
    const figures = aggregateFigures([
      {
        account_type: 'asset',
        account_subtype: 'bank',
        debit: '1500.50',
        credit: '500.25',
        account_count: '2',
      },
    ]);
    expect(figures.totalAssets).toBeCloseTo(1000.25, 2);
    expect(figures.cash).toBeCloseTo(1000.25, 2);
  });

  it('returns an all-zero shape for an empty ledger', () => {
    const figures = aggregateFigures([]);
    expect(figures.totalAssets).toBe(0);
    expect(figures.revenue).toBe(0);
    expect(figures.netProfit).toBe(0);
    expect(figures.unclassifiedCount).toBe(0);
  });
});

describe('CASH_SUBTYPES', () => {
  it('lists every raw spelling that means cash, for SQL-side filters', () => {
    expect(CASH_SUBTYPES).toContain('bank');
    expect(CASH_SUBTYPES).toContain('cash');
    expect(CASH_SUBTYPES).toContain('petty_cash');
    expect(CASH_SUBTYPES).not.toContain('receivable');
    expect(CASH_SUBTYPES).not.toContain('fixed_asset');
    // Every entry must round-trip through the canonicaliser.
    for (const raw of CASH_SUBTYPES) {
      expect(['bank', 'cash']).toContain(canonicalSubtype(raw));
    }
  });
});

describe('rawSubtypesFor', () => {
  it('returns both spellings of a subtype that has a plural alias', () => {
    const raws = rawSubtypesFor('fixed_asset');
    expect(raws).toContain('fixed_asset');
    expect(raws).toContain('fixed_assets');
    expect(raws).not.toContain('bank');
  });
});
