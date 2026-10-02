/**
 * PROFIT BEFORE TAX IS THE INCOME STATEMENT'S, NOT A SECOND DERIVATION.
 *
 * The engine built it as `operating profit − interest expense + interest
 * income`. Interest income is already inside operating profit (other income is
 * above the operating line), so it was counted twice; and bank charges and the
 * other-expense band sit below the operating line and were never taken off.
 * So the effective tax rate and PBT-to-net-interest on a pack did not
 * reconcile to the income statement on the page before them.
 *
 * It is net profit with the tax expense put back, from the same figures.
 */
import { describe, expect, it } from 'vitest';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';
import { INTEREST_IS_NET_CREDIT } from '@/modules/accounting/services/reports/ratioBasis';

const r2 = (n: number): number => Math.round(n * 100) / 100;

const balanceSheet = {
  totalAssets: 9_000_000, totalLiabilities: 3_000_000, totalEquity: 6_000_000, currentAssets: 4_000_000,
  currentLiabilities: 1_500_000, inventory: 300_000, accountsReceivable: 900_000, accountsPayable: 400_000, cash: 1_200_000,
};

/** The demo pack's shape: interest and tax are the whole gap between operating and net profit. */
const DEMO: FinancialData = {
  ...balanceSheet,
  revenue: 12_400_000, costOfSales: 7_100_000, operatingExpenses: 3_650_000, otherIncome: 0,
  operatingProfit: 1_650_000, netProfit: 1_086_400,
  interestExpense: 141_000, interestIncome: 0, taxExpense: 422_600, employeeCosts: 2_100_000, employeeCount: 14,
};
/** Brightsphere's: other income above the line, and other expenses that are not all interest and tax. */
const BRIGHTSPHERE: FinancialData = {
  ...balanceSheet,
  revenue: 13_485_163.41, costOfSales: 0, operatingExpenses: 4_748_602.81, otherIncome: 23_323.42,
  operatingProfit: 8_759_884.02, netProfit: 8_394_848.6,
  // other expenses 365 035.42 = interest 60 000.00 + tax 300 000.00 + bank charges and sundry 5 035.42
  interestExpense: 60_000, interestIncome: 23_323.42, taxExpense: 300_000, employeeCosts: 1_900_000, employeeCount: 9,
};

describe.each([['the demo company', DEMO], ['a Brightsphere-shaped company', BRIGHTSPHERE]])('%s', (_name, data) => {
  const pbt = data.netProfit + data.taxExpense!;
  const ratios = calculateExtendedRatios(data);

  it('states the effective tax rate on net profit plus tax, to the cent', () => {
    expect(ratios.effectiveTaxRate).toBe(r2((data.taxExpense! / pbt) * 100));
  });

  it('states PBT to net interest on the same profit before tax', () => {
    const netInterest = data.interestExpense! - data.interestIncome!;
    expect(ratios.pbtToNetInterest).toBe(r2(pbt / netInterest));
  });
});

describe('where the two derivations part', () => {
  it('does not count interest income twice', () => {
    // Operating profit 8 759 884.02 already holds the 23 323.42 received.
    const old = BRIGHTSPHERE.operatingProfit! - 60_000 + 23_323.42;
    expect(calculateExtendedRatios(BRIGHTSPHERE).effectiveTaxRate).not.toBe(r2((300_000 / old) * 100));
    expect(calculateExtendedRatios(BRIGHTSPHERE).effectiveTaxRate).toBe(3.45); // 300 000 / 8 694 848.60
  });

  it('has no profit before tax to state where the tax expense was not supplied', () => {
    const ratios = calculateExtendedRatios({ ...DEMO, taxExpense: undefined });
    expect(ratios.pbtToNetInterest).toBeNull();
    expect(ratios.notMeaningful.pbtToNetInterest).toBe('Tax expense is not captured in this report, so this ratio cannot be stated.');
  });
});

describe('a nil input is not always the same statement', () => {
  it('nil tax on a positive profit before tax is a rate of 0%: a rate of nil is a fact', () => {
    const ratios = calculateExtendedRatios({ ...DEMO, taxExpense: 0, netProfit: 1_509_000 });
    expect(ratios.effectiveTaxRate).toBe(0);
    expect(ratios.notMeaningful.effectiveTaxRate).toBeUndefined();
  });

  it('nil interest is no cover at all: there is nothing to cover', () => {
    const ratios = calculateExtendedRatios({ ...DEMO, interestExpense: 0 });
    expect(ratios.interestCoverage).toBeNull();
    expect(ratios.notMeaningful.interestCoverage).toBe('No interest expense under a finance-cost classification recorded in the period, so this ratio cannot be stated.');
  });

  it('a net CREDIT to interest expense says so, not "none recorded"', () => {
    const ratios = calculateExtendedRatios({ ...DEMO, interestExpense: -600 });
    for (const key of ['interestCoverage', 'ebitdaToNetInterest', 'pbtToNetInterest', 'netProfitToNetInterest'] as const) {
      expect(ratios[key]).toBeNull();
      expect(ratios.notMeaningful[key]).toBe(INTEREST_IS_NET_CREDIT);
    }
    expect(INTEREST_IS_NET_CREDIT).toBe('Interest expense is a net credit in the period, so cover on it is not meaningful.');
  });

  it('nil employee cost says what was looked for: accounts classified as payroll', () => {
    const ratios = calculateExtendedRatios({ ...DEMO, employeeCosts: 0 });
    expect(ratios.notMeaningful.employeeCostToRevenue)
      .toBe('No employee cost under a payroll classification recorded in the period, so this ratio cannot be stated.');
  });
});
