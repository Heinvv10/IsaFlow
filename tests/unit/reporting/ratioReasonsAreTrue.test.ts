/**
 * A REASON HAS TO BE TRUE OF THE COMPANY, NOT OF THE REPORT.
 *
 * When an input was absent the engine said "No interest expense is recorded,
 * so this ratio cannot be stated." That is a statement about the LEDGER, and
 * the engine cannot make it: a caller that simply did not read the interest
 * accounts got the same sentence as a company with none. The management pack
 * sent to clients said it of interest, employees, dividends and tax, and the
 * Financial Analysis scorecard said no interest was recorded beside a ratio
 * list printing Interest Cover as a figure.
 *
 * Two states, two reasons. `undefined` — the report did not capture the
 * input. A number that is nil — the input was read, and there was none.
 */
import { describe, expect, it } from 'vitest';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';

const SOUND: FinancialData = {
  revenue: 1_000_000, costOfSales: 600_000, operatingExpenses: 250_000, netProfit: 100_000,
  totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_200_000,
  currentAssets: 900_000, currentLiabilities: 450_000,
  inventory: 150_000, accountsReceivable: 200_000, accountsPayable: 120_000, cash: 300_000,
  depreciation: 40_000, amortization: 10_000, interestExpense: 30_000, interestIncome: 5_000,
  operatingCashFlow: 180_000, capitalExpenditure: 60_000, employeeCount: 10,
  employeeCosts: 400_000, directMaterialCosts: 350_000, taxExpense: 27_000, dividendsPaid: 20_000,
};

const without = (...keys: Array<keyof FinancialData>): FinancialData => {
  const data = { ...SOUND };
  for (const key of keys) delete data[key];
  return data;
};
const why = (data: FinancialData, key: string): string | undefined => calculateExtendedRatios(data).notMeaningful[key];
const valueOf = (data: FinancialData, key: string): unknown =>
  (calculateExtendedRatios(data) as unknown as Record<string, unknown>)[key];

const NOT_CAPTURED = (what: string) => `${what} is not captured in this report, so this ratio cannot be stated.`;
const NONE_RECORDED = (what: string) => `No ${what} recorded in the period, so this ratio cannot be stated.`;

describe.each([
  ['interestCoverage', 'interestExpense', 'Interest expense', 'interest expense'],
  ['ebitdaToNetInterest', 'interestExpense', 'Interest expense', 'interest expense'],
  ['pbtToNetInterest', 'interestExpense', 'Interest expense', 'interest expense'],
  ['netProfitToNetInterest', 'interestExpense', 'Interest expense', 'interest expense'],
  ['revenuePerEmployee', 'employeeCount', 'The employee count', 'employees'],
  ['pbitPerEmployee', 'employeeCount', 'The employee count', 'employees'],
  ['ebitdaPerEmployee', 'employeeCount', 'The employee count', 'employees'],
  ['employeeCostPerHead', 'employeeCount', 'The employee count', 'employees'],
  ['employeeCostToRevenue', 'employeeCosts', 'Employee cost', 'employee cost'],
  ['directMaterialMargin', 'directMaterialCosts', 'Direct material cost', 'direct material cost'],
  ['dividendCover', 'dividendsPaid', 'Dividends paid', 'dividends'],
] as const)('%s', (ratio, input, captured, recorded) => {
  it(`says the report did not capture it where ${input} is not supplied`, () => {
    expect(valueOf(without(input), ratio)).toBeNull();
    expect(why(without(input), ratio)).toBe(NOT_CAPTURED(captured));
  });

  it(`says none was recorded where ${input} is supplied as nil`, () => {
    // Interest income goes with it, so net interest is nil rather than income.
    const nil = { ...SOUND, [input]: 0, ...(input === 'interestExpense' ? { interestIncome: 0 } : {}) };
    expect(valueOf(nil, ratio)).toBeNull();
    expect(why(nil, ratio)).toBe(NONE_RECORDED(recorded));
  });

  it('never says the ledger has none when it was simply not asked', () => {
    expect(why(without(input), ratio)).not.toMatch(/recorded/);
  });
});

describe('cover on net interest', () => {
  it('says net interest is income, not that none is recorded, where income exceeds expense', () => {
    const data = { ...SOUND, interestExpense: 5_000, interestIncome: 30_000 };
    for (const ratio of ['ebitdaToNetInterest', 'pbtToNetInterest', 'netProfitToNetInterest']) {
      expect(valueOf(data, ratio)).toBeNull();
      expect(why(data, ratio)).toBe(
        'Interest income is at least interest expense in the period, so there is no net interest cost to cover.',
      );
    }
    // Interest cover on the expense itself still has a base.
    expect(valueOf(data, 'interestCoverage')).toBe(30);
  });

  it('is stated where interest income was not supplied but interest expense was', () => {
    expect(valueOf(without('interestIncome'), 'ebitdaToNetInterest')).toBe(6.67);
  });
});

describe('ratios that depend on a figure the report did not capture', () => {
  it('states no retention rate without dividends: an absent dividend is not a nil one', () => {
    // It read the absence as zero and printed 100% retained.
    expect(valueOf(without('dividendsPaid'), 'retentionRate')).toBeNull();
    expect(why(without('dividendsPaid'), 'retentionRate')).toBe(NOT_CAPTURED('Dividends paid'));
  });

  it('states a retention rate of 100% where dividends were read and were nil', () => {
    expect(valueOf({ ...SOUND, dividendsPaid: 0 }, 'retentionRate')).toBe(100);
  });

  it('states no effective tax rate without a tax figure', () => {
    expect(why(without('taxExpense'), 'effectiveTaxRate')).toBe(NOT_CAPTURED('Tax expense'));
  });

  it('states an effective tax rate of 0% where tax was read and was nil', () => {
    expect(valueOf({ ...SOUND, taxExpense: 0 }, 'effectiveTaxRate')).toBe(0);
    expect(why({ ...SOUND, taxExpense: 0 }, 'effectiveTaxRate')).toBeUndefined();
  });

  it('says the operating cash flow was not read, for both ratios that need it', () => {
    const data = without('operatingCashFlow');
    expect(why(data, 'operatingCashFlowRatio')).toBe('Not stated: no operating cash flow figure was read for this period.');
    expect(why(data, 'freeCashFlow')).toBe('Not stated: no operating cash flow figure was read for this period.');
  });
});

/**
 * VALUES THAT ARE NOT STATED FOR AN ORDINARY COMPANY, each decided on its
 * merits and pinned with the reason a reader is given.
 */
describe('a service company with no cost of sales', () => {
  const service = { ...SOUND, costOfSales: 0, inventory: 0 };
  const COST_OF_SALES = 'Cost of sales is not positive, so this ratio has no meaning.';

  it('has no creditor days: payables are measured against purchases, and there are none to measure against', () => {
    expect(valueOf(service, 'creditorDays')).toBeNull();
    expect(why(service, 'creditorDays')).toBe(COST_OF_SALES);
  });

  it('has no inventory days, for the same reason', () => {
    expect(valueOf(service, 'inventoryDays')).toBeNull();
    expect(why(service, 'inventoryDays')).toBe(COST_OF_SALES);
  });

  it('has no cash conversion cycle, which needs both', () => {
    expect(valueOf(service, 'cashConversionCycle')).toBeNull();
    expect(why(service, 'cashConversionCycle')).toBe(
      'Not stated: it depends on debtor days, inventory days or creditor days, and one of them could not be stated.',
    );
  });

  it('still has debtor days', () => {
    expect(valueOf(service, 'debtorDays')).toBe(73);
  });
});

describe('a company that made a loss', () => {
  const loss = { ...SOUND, netProfit: -80_000, operatingProfit: -50_000 };

  it('has no retention rate: there is no profit to retain a share of', () => {
    expect(valueOf(loss, 'retentionRate')).toBeNull();
    expect(why(loss, 'retentionRate')).toBe('Net profit is not positive, so this ratio has no meaning.');
  });

  it('has no effective tax rate: a rate on a loss before tax is not a rate', () => {
    expect(valueOf(loss, 'effectiveTaxRate')).toBeNull();
    expect(why(loss, 'effectiveTaxRate')).toBe('Profit before tax is not positive, so this ratio has no meaning.');
  });
});
