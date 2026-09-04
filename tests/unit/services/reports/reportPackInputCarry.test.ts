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
