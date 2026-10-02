/**
 * A REASON AGREES WITH ITS SUBJECT. "Total assets is not positive" printed on
 * the management pack; a plural base takes "are".
 */
import { describe, expect, it } from 'vitest';
import { notPositive } from '@/modules/accounting/services/reports/ratioBasis';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';

describe('notPositive', () => {
  it.each([
    ['Total assets', 'Total assets are not positive, so this ratio has no meaning.'],
    ['Current liabilities', 'Current liabilities are not positive, so this ratio has no meaning.'],
    ['Net operating assets', 'Net operating assets are not positive, so this ratio has no meaning.'],
    ['Accounts receivable', 'Accounts receivable are not positive, so this ratio has no meaning.'],
    ['Accounts payable', 'Accounts payable are not positive, so this ratio has no meaning.'],
    ['Revenue', 'Revenue is not positive, so this ratio has no meaning.'],
    ['Cost of sales', 'Cost of sales is not positive, so this ratio has no meaning.'],
    ['Inventory', 'Inventory is not positive, so this ratio has no meaning.'],
    ['Capital employed', 'Capital employed is not positive, so this ratio has no meaning.'],
    ['Net profit', 'Net profit is not positive, so this ratio has no meaning.'],
    ['Profit before tax', 'Profit before tax is not positive, so this ratio has no meaning.'],
  ])('%s', (base, sentence) => {
    expect(notPositive(base)).toBe(sentence);
  });
});

describe('every reason the engine writes agrees', () => {
  it('has no plural subject with "is" across an all-non-positive company', () => {
    const data: FinancialData = {
      revenue: -1, costOfSales: -1, operatingExpenses: 0, netProfit: -1, totalAssets: -1, totalLiabilities: 0,
      totalEquity: -1, currentAssets: 0, currentLiabilities: -1, inventory: -1, accountsReceivable: -1,
      accountsPayable: -1, cash: 0,
    };
    const reasons = Object.values(calculateExtendedRatios({ ...data, revenue: 1 }).notMeaningful)
      .concat(Object.values(calculateExtendedRatios(data).notMeaningful));
    expect(reasons.filter((r) => /\b(assets|liabilities|receivable|payable) is\b/.test(r))).toEqual([]);
    expect(reasons.some((r) => r.startsWith('Total assets are not positive'))).toBe(true);
  });
});
