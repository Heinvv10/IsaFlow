/**
 * The comparative figure set behind a pack.
 *
 * The shipped board pack printed one actual-only column because its figure
 * supply fetched one period and nothing else. These tests pin the three
 * behaviours that make a second and third column honest: the comparative is a
 * CALENDAR period, an absent prior is null rather than zeros, and an absent
 * budget is null rather than a column of zeros.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassifiedFigures,
  AccountType,
} from '@/modules/accounting/services/gl/accountClassification';
import type { PeriodFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import type { BudgetVarianceResult } from '@/modules/accounting/services/reports/budgetVarianceService';

// Hoisted: `vi.mock` factories run before module-level consts are initialised.
const { getFinancialFigures, getBudgetVariance, warn } = vi.hoisted(() => ({
  getFinancialFigures: vi.fn(),
  getBudgetVariance: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures,
}));
vi.mock('@/modules/accounting/services/reports/budgetVarianceService', () => ({
  getBudgetVariance,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import { buildPackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';

const byType = (): Record<AccountType, { accounts: number; amount: number }> => ({
  asset: { accounts: 0, amount: 0 },
  liability: { accounts: 0, amount: 0 },
  equity: { accounts: 0, amount: 0 },
  revenue: { accounts: 0, amount: 0 },
  expense: { accounts: 0, amount: 0 },
});

/** A real `ClassifiedFigures`, not a cast — every field the resolver returns. */
const classified = (over: Partial<ClassifiedFigures> = {}): ClassifiedFigures => ({
  revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0,
  operatingExpenses: 0, otherExpenses: 0, depreciation: 0,
  operatingProfit: 0, netProfit: 0,
  totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
  currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
  cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
  unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: byType(),
  ...over,
});

const figures = (revenue: number): PeriodFigures => ({
  inventoryClassified: true,
  retainedEarningsBroughtForward: 0,
  period: classified({ revenue, netProfit: revenue, operatingProfit: revenue, grossProfit: revenue }),
  cumulative: classified({ totalAssets: 1_000, totalEquity: 1_000 }),
});

/** Nothing posted through the window's end date — the company did not exist yet. */
const emptyLedger = (): PeriodFigures => ({
  inventoryClassified: true,
  retainedEarningsBroughtForward: 0,
  period: classified(),
  cumulative: classified(),
});

const variance = (rows: BudgetVarianceResult['rows']): BudgetVarianceResult => ({
  fiscalYear: 2026,
  monthKeys: ['2026-03'],
  rows,
  unbudgeted: [],
  universeTotal: rows.length,
  totals: { budget: 120, actual: 100, variance: -20 },
  unbudgetedMovement: 0,
  postedThrough: '2026-03-31',
});

const row = (): BudgetVarianceResult['rows'][number] => ({
  account_id: 'a1',
  account_code: '4000',
  account_name: 'Sales',
  account_type: 'revenue',
  budget_amount: 120,
  actual_amount: 100,
  variance: -20,
  variance_pct: -16.67,
});

describe('buildPackFigureSet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBudgetVariance.mockResolvedValue(variance([]));
  });

  it('fetches the prior period as a CALENDAR period, not a rolling window', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(getFinancialFigures).toHaveBeenCalledTimes(2);
    // February as itself. A duration-subtraction window would ask for
    // 2026-01-29..2026-02-28 and February would never appear as a period.
    expect(getFinancialFigures).toHaveBeenNthCalledWith(2, 'c1', '2026-02-01', '2026-02-28');
  });

  it('reports the two windows it actually fetched', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.currentWindow).toEqual({ start: '2026-03-01', end: '2026-03-31' });
    expect(set.priorWindow).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('scopes every fetch to the company', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    for (const call of getFinancialFigures.mock.calls) expect(call[0]).toBe('c1');
    for (const call of getBudgetVariance.mock.calls) expect(call[0]).toBe('c1');
  });

  it('carries a null prior rather than zeros when the prior fetch fails', async () => {
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockRejectedValueOnce(new Error('no data'));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.prior).toBeNull();
    // A zeroed prior column prints "-100%" against a real current figure,
    // which is a lie about the business rather than an absent comparative.
    expect(set.current.revenue).toBe(100);
    expect(warn).toHaveBeenCalled();
  });

  it('carries a null prior when the prior window has no ledger at all', async () => {
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockResolvedValueOnce(emptyLedger());
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.prior).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('keeps a prior that is zero on the P&L but carries a balance sheet', async () => {
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockResolvedValueOnce(figures(0));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    // A dormant month is a real comparative: the company existed and held assets.
    expect(set.prior?.totalAssets).toBe(1_000);
  });

  it('carries a null budget where the company has none', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    // The real service never returns null — a company with no budget gets a
    // result whose `rows` array is empty. A caller must not have to know that.
    getBudgetVariance.mockResolvedValue(variance([]));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.budget).toBeNull();
  });

  it('carries the budget totals and rows where the company has one', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    getBudgetVariance.mockResolvedValue(variance([row()]));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.budget?.totals).toEqual({ budget: 120, actual: 100, variance: -20 });
    expect(set.budget?.rows).toEqual([
      {
        accountCode: '4000', accountName: 'Sales', accountType: 'revenue',
        budget: 120, actual: 100, variance: -20, variancePct: -16.67,
      },
    ]);
  });

  it('carries a null budget rather than failing the pack when the budget fetch throws', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    getBudgetVariance.mockRejectedValue(new Error('budget table missing'));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.budget).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('handles a negative-revenue current period without special-casing it', async () => {
    // Brightsphere, 2026-03..08. Honest data, not a bug.
    getFinancialFigures.mockResolvedValue(figures(-50_000));
    const set = await buildPackFigureSet('c1', 'Brightsphere', '2026-03-01', '2026-03-31');
    expect(set.current.revenue).toBe(-50_000);
  });
});
