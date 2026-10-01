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
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

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
});

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
