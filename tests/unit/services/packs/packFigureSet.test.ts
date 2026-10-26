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
const { getFinancialFigures, getBudgetVariance, getCashFlowDirect, warn } = vi.hoisted(() => ({
  getFinancialFigures: vi.fn(),
  getBudgetVariance: vi.fn(),
  getCashFlowDirect: vi.fn(),
  warn: vi.fn(),
}));
const NO_CASH_FLOWS = { operatingTotal: 0, investingTotal: 0, financingTotal: 0, netChange: 0 };

vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures,
}));
// The cash flows `getReportPackInput` carries are pinned in
// `reportPackInputCarry.test.ts`; here the read is stood in for so these
// tests stay about the figure SET.
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect,
}));
// The ledger ratio inputs `getReportPackInput` carries (interest, tax, head
// count) are pinned in `reportPackLedgerRatios.test.ts` and
// `packRatioInputsFailedRead.test.ts`. Stood in for here: left real, the read
// goes to whatever database the environment names.
vi.mock('@/modules/accounting/services/reports/extendedRatioInputs', () => ({
  readLedgerRatioInputs: async () => ({
    employeeCount: 0, interestExpense: 0, interestIncome: 0, employeeCosts: 0, taxExpense: 0,
  }),
}));
vi.mock('@/modules/accounting/services/reports/budgetVarianceService', () => ({
  getBudgetVariance,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import { buildPackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { fakeRequestTx, pgError, touchLedger } from './support/fakeRequestTx';

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
    getCashFlowDirect.mockResolvedValue(NO_CASH_FLOWS);
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
      .mockRejectedValueOnce(pgError('57014', 'canceling statement due to statement timeout'));
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

  it('keeps a prior whose only movement is other income', async () => {
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockResolvedValueOnce({
        ...emptyLedger(),
        period: classified({ otherIncome: 250, netProfit: 0 }),
      });
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    // `carriesLedger` claims to check every P&L line; other income is one.
    expect(set.prior?.otherIncome).toBe(250);
  });

  it('carries a null budget where the company has none', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    // The real service never returns null — a company with no budget gets a
    // result whose `rows` array is empty. A caller must not have to know that.
    getBudgetVariance.mockResolvedValue(variance([]));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.budget).toBeNull();
  });

  it('passes a null budget percentage through as null, never 0 or -100 (zero budget)', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    getBudgetVariance.mockResolvedValue(variance([{ ...row(), budget_amount: 0, variance: -100, variance_pct: null }]));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.budget?.rows[0]?.variancePct).toBeNull();
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
    getBudgetVariance.mockRejectedValue(pgError('57014', 'canceling statement due to statement timeout'));
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

/**
 * A CAUGHT DATABASE ERROR IS NOT A RECOVERED TRANSACTION.
 *
 * Under `withAuth` the whole request is one transaction on one connection.
 * `fetchPrior` and `fetchBudget` caught a failed read and carried on — and
 * Postgres had already aborted the transaction, so the NEXT read was refused
 * with 25P02 whatever it asked for. "No comparative" therefore also meant "no
 * budget", and then a 500 from the first read that had no catch around it.
 * Each degrading read now runs in its own savepoint and rolls back to it.
 *
 * These run against a client that aborts the way Postgres does, rather than
 * against a rejected mock, because a rejected mock cannot show the difference.
 */
describe('a degrading read inside the request transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCashFlowDirect.mockResolvedValue(NO_CASH_FLOWS);
  });

  /** The two `getFinancialFigures` calls, told apart by the window asked for. */
  function figuresTouchTheLedger(): void {
    getFinancialFigures.mockImplementation(async (_c: string, from: string) => {
      await touchLedger(from === '2026-03-01' ? 'current' : 'prior');
      return figures(100);
    });
  }
  function budgetTouchesTheLedger(): void {
    getBudgetVariance.mockImplementation(async () => {
      await touchLedger('budget');
      return variance([row()]);
    });
  }
  const failing = (tag: string) => (statement: string) =>
    (statement.includes(`/* ${tag} */`) ? pgError('57014', 'canceling statement due to statement timeout') : null);

  it('rolls a failed prior read back, so the budget read after it still answers', async () => {
    figuresTouchTheLedger();
    budgetTouchesTheLedger();
    const tx = fakeRequestTx(failing('prior'));

    const set = await tx.run(() => buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31'));

    expect(set.prior).toBeNull();
    // The read AFTER the failure. Without a savepoint it is refused with
    // 25P02 and the pack loses a budget column it had nothing wrong with.
    expect(set.budget?.totals.budget).toBe(120);
    expect(tx.isAborted()).toBe(false);
    const prior = tx.statements.indexOf('/* prior */ SELECT 1');
    expect(tx.statements[prior - 1]).toMatch(/^SAVEPOINT \w+$/);
    expect(tx.statements[prior + 1]).toMatch(/^ROLLBACK TO SAVEPOINT \w+$/);
  });

  it('rolls a failed budget read back, so whatever the request reads next still answers', async () => {
    figuresTouchTheLedger();
    budgetTouchesTheLedger();
    const tx = fakeRequestTx(failing('budget'));

    await tx.run(async () => {
      const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
      expect(set.budget).toBeNull();
      expect(set.prior?.revenue).toBe(100);
      // The trend, the matters and every read after this in the document.
      await expect(touchLedger('trend')).resolves.toBeUndefined();
    });
  });

  it('rolls a failed cash flow read back, and the figures, comparative and budget still arrive', async () => {
    figuresTouchTheLedger();
    budgetTouchesTheLedger();
    // Fails on the CURRENT window only: the read sits after the current
    // figures and before the comparative.
    getCashFlowDirect.mockImplementation(async (_c: string, from: string) => {
      await touchLedger(from === '2026-03-01' ? 'cashflow' : 'priorcashflow');
      return { operatingTotal: 70, investingTotal: -20, financingTotal: 5, netChange: 55 };
    });
    const tx = fakeRequestTx(failing('cashflow'));

    const set = await tx.run(() => buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31'));

    expect(set.current.revenue).toBe(100);
    expect(set.current.operatingCashFlow).toBeUndefined();
    // Read after the failure, on the same transaction.
    expect(set.prior?.operatingCashFlow).toBe(70);
    expect(set.prior?.investingCashFlow).toBe(-20);
    expect(set.budget?.totals.budget).toBe(120);
    expect(tx.isAborted()).toBe(false);
  });

  it('does not let a failed CURRENT read degrade to anything — there is no pack without it', async () => {
    figuresTouchTheLedger();
    budgetTouchesTheLedger();
    const tx = fakeRequestTx(failing('current'));
    await expect(tx.run(() => buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31')))
      .rejects.toMatchObject({ code: '57014' });
  });

  it('does not call a code bug in the prior read "no comparative"', async () => {
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'amount')"));
    getBudgetVariance.mockResolvedValue(variance([]));
    await expect(buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31'))
      .rejects.toBeInstanceOf(TypeError);
  });

  it('does not call a code bug in the budget read "no budget"', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    getBudgetVariance.mockRejectedValue(new TypeError('rows.map is not a function'));
    await expect(buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31'))
      .rejects.toBeInstanceOf(TypeError);
  });

  it('logs the class and SQLSTATE of a failed read, never the driver\'s sentence', async () => {
    // A node-postgres message carries whatever the server put in it — the
    // statement, the offending row. It was logged whole, by `String(error)`.
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockRejectedValueOnce(pgError('57014', 'canceling statement: SELECT … WHERE customer = \'Blitz Fibre\''));
    getBudgetVariance.mockRejectedValue(pgError('40P01', 'deadlock detected: Process 71 waits for row (0,7) of account_budgets'));
    await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');

    const logged = warn.mock.calls.map((call) => call[1] as { error: string });
    expect(logged.map((l) => l.error)).toEqual(['Error (SQLSTATE 57014)', 'Error (SQLSTATE 40P01)']);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Blitz Fibre|account_budgets|SELECT/);
  });

  it('does not call a missing table "no budget"', async () => {
    // 42P01 is a migration that never ran, or a typo in a query. It used to
    // degrade like a timeout, and a pack went out without its budget column
    // on the strength of one warn.
    getFinancialFigures.mockResolvedValue(figures(100));
    getBudgetVariance.mockRejectedValue(pgError('42P01', 'relation "account_budgets" does not exist'));
    await expect(buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31'))
      .rejects.toMatchObject({ code: '42P01' });
  });

  it('does not degrade on a transaction that was already aborted before the read', async () => {
    // 25P02 is not this read failing: something earlier did, and nothing
    // after it can be trusted to have run.
    getFinancialFigures
      .mockResolvedValueOnce(figures(100))
      .mockRejectedValueOnce(pgError('25P02', 'current transaction is aborted'));
    getBudgetVariance.mockResolvedValue(variance([]));
    await expect(buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31'))
      .rejects.toMatchObject({ code: '25P02' });
  });
});
