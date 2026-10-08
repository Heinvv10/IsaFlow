/**
 * A RATIO BUILT ON REVENUE HAS NO MEANING WHERE REVENUE IS NOT POSITIVE —
 * WHETHER REVENUE IS ITS DENOMINATOR OR ITS NUMERATOR.
 *
 * The margins and debtor days were already guarded (revenue is their base).
 * The turnovers and the per-head figures carry revenue on TOP, and on a
 * period whose credit notes exceeded its sales the management pack printed
 * "Asset Turnover (1.73)×", "Net Operating Asset Turnover (6.49)×" and
 * "Revenue per Employee (5 535 000.00)" — Brightsphere, page 6. A turnover of
 * minus 1.73 times is not a speed at which assets were turned into sales.
 *
 * PBIT and EBITDA per employee follow the margins: on non-positive revenue the
 * period's profit is the reversal of sales, not the output of its staff, and
 * the pack states the margins on that profit as not meaningful. On positive
 * revenue a negative profit per employee is a true figure and is stated.
 *
 * The cost-of-sales turnovers follow creditor and inventory days, which were
 * already not stated on non-positive cost of sales.
 */
import { describe, expect, it } from 'vitest';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';
import { NO_STOCK_HELD } from '@/modules/accounting/services/reports/ratioBasis';

const COMPANY: FinancialData = {
  periodDays: 365,
  revenue: 1_000_000, costOfSales: 600_000, operatingExpenses: 250_000, otherIncome: 0, operatingProfit: 150_000,
  netProfit: 93_000, totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_200_000,
  currentAssets: 900_000, currentLiabilities: 450_000, inventory: 150_000, accountsReceivable: 200_000,
  accountsPayable: 120_000, cash: 300_000, depreciation: 40_000,
  interestExpense: 30_000, interestIncome: 0, taxExpense: 27_000, employeeCosts: 400_000, employeeCount: 12,
};
/** Brightsphere's shape: credit notes exceeding sales. */
const NEGATIVE_REVENUE: FinancialData = { ...COMPANY, revenue: -5_535_000, operatingProfit: -6_300_000, netProfit: -6_400_000 };
const NIL_REVENUE: FinancialData = { ...COMPANY, revenue: 0, operatingProfit: -850_000, netProfit: -910_000 };

const REVENUE = 'Revenue is not positive, so this ratio has no meaning.';
const COST_OF_SALES = 'Cost of sales is not positive, so this ratio has no meaning.';

/** Every ratio with revenue as its numerator or its denominator. */
const ON_REVENUE = [
  'grossProfitMargin', 'netProfitMargin', 'operatingProfitMargin', 'debtorDays',
  'ebitdaMargin', 'pbitMargin', 'dupontMargin', 'employeeCostToRevenue',
  'assetTurnover', 'receivablesTurnover', 'netOperatingAssetTurnover', 'dupontTurnover',
  'revenuePerEmployee', 'pbitPerEmployee', 'ebitdaPerEmployee',
] as const;

describe.each([['negative revenue', NEGATIVE_REVENUE], ['nil revenue', NIL_REVENUE]])('on %s', (_name, data) => {
  const ratios = calculateExtendedRatios(data);

  it.each(ON_REVENUE)('%s is not stated, because revenue is not positive', (key) => {
    expect(ratios[key]).toBeNull();
    expect(ratios.notMeaningful[key]).toBe(REVENUE);
  });

  it('still states what does not stand on revenue', () => {
    expect(ratios.currentRatio).toBe(2);
    expect(ratios.ebitda).toBe(data.operatingProfit! + 40_000);
    expect(ratios.returnOnAssets).not.toBeNull();
    expect(ratios.employeeCostPerHead).toBe(33_333.33);
  });
});

describe('on positive revenue', () => {
  it.each(ON_REVENUE)('%s is stated', (key) => {
    const ratios = calculateExtendedRatios(COMPANY);
    expect(ratios[key], key).not.toBeNull();
  });

  it('states a negative profit per employee: a loss on real sales is a true figure', () => {
    const ratios = calculateExtendedRatios({ ...COMPANY, operatingProfit: -120_000, netProfit: -150_000, depreciation: 0 });
    expect(ratios.pbitPerEmployee).toBe(-10_000);
    expect(ratios.ebitdaPerEmployee).toBe(-10_000);
  });
});

describe('the turnovers on cost of sales follow creditor and inventory days', () => {
  it.each([0, -40_000])('on cost of sales of %s, inventory and payables turnover are not stated', (costOfSales) => {
    const ratios = calculateExtendedRatios({ ...COMPANY, costOfSales });
    for (const key of ['inventoryTurnover', 'payablesTurnover', 'creditorDays', 'inventoryDays'] as const) {
      expect(ratios[key], key).toBeNull();
      expect(ratios.notMeaningful[key], key).toBe(COST_OF_SALES);
    }
  });
});

describe('inventory turnover and inventory days say the same thing', () => {
  it('a company holding no stock has inventory days of nil, and its turnover says why it has none', () => {
    const ratios = calculateExtendedRatios({ ...COMPANY, inventory: 0 });
    expect(ratios.inventoryDays).toBe(0);
    expect(ratios.notMeaningful.inventoryDays).toBeUndefined();
    expect(ratios.inventoryTurnover).toBeNull();
    expect(ratios.notMeaningful.inventoryTurnover).toBe(NO_STOCK_HELD);
    expect(NO_STOCK_HELD).toBe('No inventory is held, so there is no stock to turn over; inventory days are nil.');
    // And the cycle is still stated on it.
    expect(ratios.cashConversionCycle).not.toBeNull();
  });

  it('negative inventory: both not stated, with the same reason', () => {
    const ratios = calculateExtendedRatios({ ...COMPANY, inventory: -5_000 });
    expect([ratios.inventoryTurnover, ratios.inventoryDays]).toEqual([null, null]);
    expect(ratios.notMeaningful.inventoryTurnover).toBe('Inventory is not positive, so this ratio has no meaning.');
    expect(ratios.notMeaningful.inventoryDays).toBe(ratios.notMeaningful.inventoryTurnover);
  });

  it('stock held on positive cost of sales: both stated, one the other\'s reciprocal in days', () => {
    const ratios = calculateExtendedRatios(COMPANY);
    expect(ratios.inventoryTurnover).toBe(4);
    expect(ratios.inventoryDays).toBe(91.25);
  });
});
