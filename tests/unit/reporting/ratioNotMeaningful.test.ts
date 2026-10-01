/**
 * A RATIO ON A BASE THAT IS NOT POSITIVE IS NOT A NUMBER.
 *
 * The engine answered 0 for a zero base and a sign-flipped figure for a
 * negative one. A company with negative turnover — reversals exceeding sales
 * in the period — therefore printed "gross margin 100", "net margin 25.43"
 * and "ROCE 69.96" on its management pack while its board pack, which guards
 * the same quotients, printed "n/m". And a ratio whose input nobody supplied
 * printed 0: free cash flow, interest cover, revenue per employee.
 *
 * Every such ratio is null now, with its reason under the same key.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateExtendedRatios, calculateFinancialRatios, type FinancialData,
} from '@/modules/accounting/services/reports/reportingEngineService';

/** A healthy trading company with every optional input supplied. */
const SOUND: FinancialData = {
  revenue: 1_000_000, costOfSales: 600_000, operatingExpenses: 250_000, netProfit: 100_000,
  totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_200_000,
  currentAssets: 900_000, currentLiabilities: 450_000,
  inventory: 150_000, accountsReceivable: 200_000, accountsPayable: 120_000, cash: 300_000,
  depreciation: 40_000, amortization: 10_000, interestExpense: 30_000, interestIncome: 5_000,
  operatingCashFlow: 180_000, capitalExpenditure: 60_000, employeeCount: 10,
  employeeCosts: 400_000, directMaterialCosts: 350_000, taxExpense: 27_000, dividendsPaid: 20_000,
};

/** Brightsphere's shape: reversals exceed sales, so turnover is negative. */
const NEGATIVE_REVENUE: FinancialData = { ...SOUND, revenue: -5_535_000, costOfSales: 0, netProfit: -1_407_000, operatingProfit: -1_819_000 };

const ratioKeys = (r: object): string[] => Object.keys(r).filter((k) => k !== 'notMeaningful');

describe('on a sound company with every input supplied', () => {
  const r = calculateExtendedRatios(SOUND);

  it('computes every ratio and gives no reason for any', () => {
    for (const key of ratioKeys(r)) {
      expect((r as unknown as Record<string, unknown>)[key], key).toEqual(expect.any(Number));
    }
    expect(r.notMeaningful).toEqual({});
  });

  it('keeps the figures it always computed', () => {
    expect(r.grossProfitMargin).toBe(40);
    expect(r.netProfitMargin).toBe(10);
    expect(r.currentRatio).toBe(2);
    expect(r.debtorDays).toBe(73);
    expect(r.ebitda).toBe(200_000);
    expect(r.ebitdaMargin).toBe(20);
    expect(r.freeCashFlow).toBe(120_000);
    expect(r.operatingCashFlowRatio).toBe(0.4);
    expect(r.interestCoverage).toBe(5);
  });
});

describe('on non-positive revenue', () => {
  const REVENUE_BASED = [
    'grossProfitMargin', 'netProfitMargin', 'operatingProfitMargin', 'debtorDays',
    'ebitdaMargin', 'pbitMargin', 'directMaterialMargin', 'employeeCostToRevenue',
    'dupontMargin',
  ] as const;

  it.each([['negative', NEGATIVE_REVENUE], ['zero', { ...SOUND, revenue: 0 }]])(
    'states no margin and no day count on %s turnover', (_what, data) => {
      const r = calculateExtendedRatios(data);
      for (const key of REVENUE_BASED) {
        expect(r[key], key).toBeNull();
        expect(r.notMeaningful[key], key).toBe('Revenue is not positive, so this ratio has no meaning.');
      }
    },
  );

  it('states no cash conversion cycle, which is built on a day count it could not state', () => {
    const r = calculateExtendedRatios(NEGATIVE_REVENUE);
    expect(r.cashConversionCycle).toBeNull();
    expect(r.notMeaningful.cashConversionCycle).toMatch(/depends on/i);
  });

  it('still states what does not rest on revenue', () => {
    const r = calculateExtendedRatios(NEGATIVE_REVENUE);
    expect(r.currentRatio).toBe(2);
    expect(r.ebitda).toBe(-1_769_000);
    expect(r.workingCapital).toBe(450_000);
  });

  it('applies to the base ratios too', () => {
    const r = calculateFinancialRatios(NEGATIVE_REVENUE);
    expect(r.grossProfitMargin).toBeNull();
    expect(r.notMeaningful.grossProfitMargin).toMatch(/Revenue is not positive/);
  });
});

describe('on any other base that is not positive', () => {
  it.each([
    ['creditorDays', { costOfSales: 0 }, /Cost of sales/],
    ['inventoryTurnover', { inventory: -1 }, /Inventory/],
    ['inventoryDays', { inventory: -1 }, /Inventory/],
    ['inventoryDays', { costOfSales: 0 }, /Cost of sales/],
    ['payablesTurnover', { accountsPayable: 0 }, /Accounts payable/],
    ['receivablesTurnover', { accountsReceivable: -5 }, /Accounts receivable/],
    ['returnOnAssets', { totalAssets: 0 }, /Total assets/],
    ['assetTurnover', { totalAssets: -1 }, /Total assets/],
    ['debtRatio', { totalAssets: 0 }, /Total assets/],
    ['dupontTurnover', { totalAssets: 0 }, /Total assets/],
    ['currentRatio', { currentLiabilities: 0 }, /Current liabilities/],
    ['quickRatio', { currentLiabilities: 0 }, /Current liabilities/],
    ['cashRatio', { currentLiabilities: -1 }, /Current liabilities/],
    ['operatingCashFlowRatio', { currentLiabilities: 0 }, /Current liabilities/],
    ['roce', { totalAssets: 400_000 }, /Capital employed/],
    ['netOperatingAssetTurnover', { totalAssets: 700_000 }, /Net operating assets/],
    ['retentionRate', { netProfit: -10 }, /Net profit/],
  ] as const)('%s is null with a reason', (key, over, reason) => {
    const r = calculateExtendedRatios({ ...SOUND, ...over });
    expect((r as unknown as Record<string, unknown>)[key]).toBeNull();
    expect(r.notMeaningful[key]).toMatch(reason);
    expect(r.notMeaningful[key]).toMatch(/not positive/);
  });
});

describe('a company that holds no stock', () => {
  const r = calculateExtendedRatios({ ...SOUND, inventory: 0 });

  it('has no inventory turnover, and inventory days of exactly nil', () => {
    expect(r.inventoryTurnover).toBeNull();
    expect(r.inventoryDays).toBe(0);
    expect(r.notMeaningful.inventoryDays).toBeUndefined();
  });

  it('has a cash conversion cycle of debtor days less creditor days', () => {
    expect(r.cashConversionCycle).toBe(0);
    expect(calculateExtendedRatios({ ...SOUND, inventory: 0, accountsPayable: 60_000 }).cashConversionCycle).toBe(36.5);
  });
});

describe('where an input was never supplied', () => {
  const omit = (...keys: Array<keyof FinancialData>): FinancialData => {
    const data = { ...SOUND };
    for (const key of keys) delete data[key];
    return data;
  };

  it.each([
    ['freeCashFlow', omit('capitalExpenditure'), /capital expenditure/i],
    ['freeCashFlow', omit('operatingCashFlow'), /operating cash flow/i],
    ['operatingCashFlowRatio', omit('operatingCashFlow'), /operating cash flow/i],
    ['interestCoverage', omit('interestExpense'), /interest expense/i],
    ['ebitdaToNetInterest', omit('interestExpense', 'interestIncome'), /Interest expense is not captured/],
    ['pbtToNetInterest', omit('interestExpense', 'interestIncome'), /Interest expense is not captured/],
    ['netProfitToNetInterest', omit('interestExpense', 'interestIncome'), /Interest expense is not captured/],
    ['revenuePerEmployee', omit('employeeCount'), /employee count/i],
    ['pbitPerEmployee', omit('employeeCount'), /employee count/i],
    ['ebitdaPerEmployee', omit('employeeCount'), /employee count/i],
    ['employeeCostPerHead', omit('employeeCount'), /employee count/i],
    ['employeeCostToRevenue', omit('employeeCosts'), /Employee cost is not captured/],
    ['directMaterialMargin', omit('directMaterialCosts'), /direct material/i],
    ['dividendCover', omit('dividendsPaid'), /dividends/i],
    ['effectiveTaxRate', omit('taxExpense'), /tax expense/i],
  ] as const)('%s is null, never 0', (key, data, reason) => {
    const r = calculateExtendedRatios(data);
    expect((r as unknown as Record<string, unknown>)[key]).toBeNull();
    expect(r.notMeaningful[key]).toMatch(reason);
  });

  it('gives a reason for every null and a null for every reason', () => {
    const bare: FinancialData = {
      revenue: 0, costOfSales: 0, operatingExpenses: 0, netProfit: 0, totalAssets: 0,
      totalLiabilities: 0, totalEquity: 0, currentAssets: 0, currentLiabilities: 0,
      inventory: 0, accountsReceivable: 0, accountsPayable: 0, cash: 0,
    };
    for (const data of [bare, NEGATIVE_REVENUE, omit('capitalExpenditure', 'employeeCount')]) {
      const r = calculateExtendedRatios(data);
      const nulls = ratioKeys(r).filter((k) => (r as unknown as Record<string, unknown>)[k] === null).sort();
      expect(Object.keys(r.notMeaningful).sort()).toEqual(nulls);
    }
  });
});
