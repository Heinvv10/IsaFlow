/**
 * `getReportPackInput` must CARRY the bands the pack renders.
 *
 * Zeroing either field here left every pack-rendering test green: the pack
 * renders what it is handed, and it was handed nothing. That was the original
 * defect — `buildProfitWaterfall` gates its Other Income and Other Expenses
 * steps on `!== 0`, so both were suppressed on every pack ever produced and the
 * Net Profit subtotal hung off the running total by R341,712.00 on Brightsphere.
 *
 * Mocked at the figures boundary so the assertion is about the CARRY, not about
 * any ledger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const figuresMock = vi.fn();
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/gl/financialFiguresService')>();
  return { ...actual, getFinancialFigures: (...a: unknown[]) => figuresMock(...a) };
});
const cashFlowMock = vi.fn();
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: (...a: unknown[]) => cashFlowMock(...a),
}));
// `withSavepoint` is the real one: outside a request transaction it runs the
// read as it stands.
vi.mock('@/lib/neon', async (orig) => ({ ...(await orig<Record<string, unknown>>()), sql: vi.fn() }));
const warnMock = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => warnMock(...a) } }));

import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';

const PERIOD = {
  revenue: 13485163.41, otherIncome: 23323.42, costOfSales: 0,
  operatingExpenses: 4748602.81, otherExpenses: 365035.42,
  operatingProfit: 8759884.02, netProfit: 8394848.60, depreciation: 0,
  grossProfit: 13485163.41,
  totalAssets: 100, totalLiabilities: 0, totalEquity: 100,
  currentAssets: 100, nonCurrentAssets: 0, currentLiabilities: 1, nonCurrentLiabilities: 0,
  cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
  unclassifiedCount: 0, unclassifiedTotal: 0,
  unclassifiedByType: {
    asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
    equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
    expense: { accounts: 0, amount: 0 },
  },
};

beforeEach(() => {
  figuresMock.mockReset();
  figuresMock.mockResolvedValue({ period: PERIOD, cumulative: PERIOD });
  cashFlowMock.mockReset();
  cashFlowMock.mockResolvedValue(cashFlow(0, 0, 0));
});

/** A direct-method report as `getCashFlowDirect` returns it. */
function cashFlow(operatingTotal: number, investingTotal: number, financingTotal: number) {
  const netChange = operatingTotal + investingTotal + financingTotal;
  return {
    periodStart: '2026-03-01', periodEnd: '2026-08-31', openingCash: 1_000,
    operatingItems: [], operatingTotal, investingItems: [], investingTotal,
    financingItems: [], financingTotal, netChange, closingCash: 1_000 + netChange,
  };
}

describe('getReportPackInput', () => {
  it('carries otherIncome, otherExpenses and operatingProfit', async () => {
    const input = await getReportPackInput('c-1', 'Brightsphere', '2020-01-01', '2030-12-31');
    expect(input.otherIncome).toBeCloseTo(23323.42, 2);
    expect(input.otherExpenses).toBeCloseTo(365035.42, 2);
    expect(input.operatingProfit).toBeCloseTo(8759884.02, 2);
  });

  it('carries enough for the pack to FOOT', async () => {
    const i = await getReportPackInput('c-1', 'Brightsphere', '2020-01-01', '2030-12-31');
    const grossProfit = i.revenue - i.costOfSales;
    const op = grossProfit + (i.otherIncome ?? 0) - i.operatingExpenses;
    expect(op - (i.otherExpenses ?? 0)).toBeCloseTo(i.netProfit, 2);
    // Zeroed, the reconciliation fails by exactly the amount that was invisible.
    expect(grossProfit - i.operatingExpenses).not.toBeCloseTo(i.netProfit, 2);
  });
});

/**
 * EBITDA IS OPERATING PROFIT PLUS THIS FIGURE, and nothing read it back.
 *
 * `PERIOD` above sets `depreciation: 0`, so dropping the carry — or defaulting
 * it — produced the same pack input and every test stayed green, while the
 * board pack's EBITDA row silently became the operating line again.
 */
describe('getReportPackInput carries the depreciation charge', () => {
  it('carries the PERIOD charge, not zero and not the cumulative figure', async () => {
    figuresMock.mockResolvedValue({
      period: { ...PERIOD, depreciation: 184_250.75 },
      cumulative: { ...PERIOD, depreciation: 9_999_999 },
    });
    const input = await getReportPackInput('c-1', 'Brightsphere', '2026-03-01', '2026-08-31');
    expect(input.depreciation).toBe(184_250.75);
  });
});

/**
 * THE CAVEATS REACH A BOARD PACK IN THE BOARD'S WORDING.
 *
 * Each warning carries two sentences for one fact: `message` for the operator
 * screens, which names `account_subtype` and tells the reader to set it, and
 * `board` for a document a director receives. The pack once printed the
 * operator one as caveat 1 on its basis-of-preparation page.
 */
describe('getReportPackInput carries the caveats in the board wording', () => {
  const unclassified = (accounts: number) => ({
    ...PERIOD,
    unclassifiedCount: accounts,
    unclassifiedTotal: 5_000,
    unclassifiedByType: {
      ...PERIOD.unclassifiedByType,
      asset: { accounts, amount: 5_000 },
    },
  });

  it('states an unidentified inventory for a director, not for an administrator', async () => {
    figuresMock.mockResolvedValue({ inventoryClassified: false, period: PERIOD, cumulative: PERIOD });
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(input.inventoryCaveat).toBe(
      'No account in the chart of accounts is classified as inventory, so '
      + 'inventory could not be identified and the quick ratio does not exclude '
      + 'it: on these figures the quick ratio and the current ratio are the same '
      + 'number. Read it as a current ratio until the stock control account is '
      + 'classified.',
    );
    expect(input.inventoryCaveat).not.toMatch(/account_subtype|Set /);
  });

  it('states defaulted classifications for a director, counted off the balance-sheet figures', async () => {
    // The count comes from the CUMULATIVE figures: the classification splits
    // the caveat is about are balance-sheet positions. The period carries a
    // different count so reading the wrong one is visible.
    figuresMock.mockResolvedValue({
      inventoryClassified: true, period: unclassified(7), cumulative: unclassified(3),
    });
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(input.classificationCaveat).toBe(
      '3 accounts in the chart of accounts carry no recognised classification, so each was '
      + 'reported in its default position — assets and liabilities as current, revenue as '
      + 'revenue rather than other income, and expenses as operating rather than cost of sales. '
      + 'The totals are complete; where a figure sits within them may not be.',
    );
    expect(input.classificationCaveat).not.toMatch(/account_subtype|account\(s\)|Set /);
  });

  it('carries no caveat where there is nothing to caveat', async () => {
    figuresMock.mockResolvedValue({ inventoryClassified: true, period: PERIOD, cumulative: PERIOD });
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(input.inventoryCaveat).toBeNull();
    expect(input.classificationCaveat).toBeNull();
  });
});

/**
 * PAGE 8 PRINTED THREE "n/m" ROWS ON EVERY TENANT, because nothing populated
 * the pack's cash-flow figures. They come from `getCashFlowDirect`, the
 * direct-method statement: every posted cash leg in the window, distributed
 * once across the accounts on the other side of its entry.
 */
describe('getReportPackInput carries the cash flows of the window it was asked for', () => {
  it('asks the direct-method service about this company and this window', async () => {
    await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(cashFlowMock).toHaveBeenCalledTimes(1);
    expect(cashFlowMock).toHaveBeenCalledWith('c-1', '2026-03-01', '2026-08-31');
  });

  it('carries operating, investing and financing, each under its own name', async () => {
    cashFlowMock.mockResolvedValue(cashFlow(345_678.12, -98_765.43, 12_345.67));
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(input.operatingCashFlow).toBe(345_678.12);
    expect(input.investingCashFlow).toBe(-98_765.43);
    expect(input.financingCashFlow).toBe(12_345.67);
    expect(input.cashFlowUnavailable).toBeNull();
  });

  it('does not call net investing "capital expenditure"', async () => {
    // The service nets acquisitions against disposals in one figure. Carried
    // as capex it would change every Free Cash Flow that reads the field.
    cashFlowMock.mockResolvedValue(cashFlow(500, -98_765.43, 0));
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(input.capitalExpenditure).toBeUndefined();
  });

  it('states each figure to the cent, and the three still foot to the movement in cash', async () => {
    // The service apportions cash legs by division, so its totals carry
    // float dust and three figures rounded apart can miss their own sum by a
    // cent. Page 8 bridges opening cash to closing cash through them.
    const noisy = cashFlow(100_000.004, -39_999.996, 5_000.004);
    cashFlowMock.mockResolvedValue(noisy);
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    const cents = (n: number) => Math.round(n * 100);
    for (const figure of [input.operatingCashFlow!, input.investingCashFlow!, input.financingCashFlow!]) {
      expect(Math.abs(figure * 100 - cents(figure))).toBeLessThan(1e-6);
    }
    expect(cents(input.operatingCashFlow!) + cents(input.investingCashFlow!) + cents(input.financingCashFlow!))
      .toBe(cents(noisy.netChange));
    // Rounded apart they come to 65 000.00 against a movement of 65 000.01.
    expect(cents(noisy.netChange)).toBe(6_500_001);
  });

  it('carries none of the three when the database refuses the read, as an absent comparative is carried', async () => {
    // Page 8 prints "n/m" with its reason for an absent figure. A statement
    // that could not be read is absent, not nil — and it is not a reason to
    // lose the eleven sheets that do not depend on it.
    warnMock.mockClear();
    cashFlowMock.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const input = await getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31');
    expect(input.operatingCashFlow).toBeUndefined();
    expect(input.investingCashFlow).toBeUndefined();
    expect(input.financingCashFlow).toBeUndefined();
    // And it says WHY they are absent, in a sentence for the reader: a page
    // printing "no figure was captured" would be describing a different fact.
    expect(input.cashFlowUnavailable).toBe('The cash flow statement could not be read for this period.');
    // The figures that were read are still there.
    expect(input.revenue).toBeCloseTo(13485163.41, 2);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('does not call a code bug in the statement "no cash flow figures"', async () => {
    cashFlowMock.mockRejectedValue(new TypeError('legs.values is not a function'));
    await expect(getReportPackInput('c-1', 'Demo', '2026-03-01', '2026-08-31'))
      .rejects.toBeInstanceOf(TypeError);
  });
});
