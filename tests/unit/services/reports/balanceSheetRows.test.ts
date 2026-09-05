import { describe, it, expect } from 'vitest';
import { toBalanceSheetRows } from '@/modules/accounting/services/reports/statementRows/balanceSheetRows';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.report.types';

/**
 * Deliberately OUT OF BALANCE: 500000 of assets against 470000 of claims.
 * With a balanced fixture, `Total Liabilities and Equity` could be wired to
 * `r.totalAssets` and every assertion below would still pass.
 */
const R: BalanceSheetReport = {
  asAtDate: '2026-08-31',
  assets: [{ accountCode: '1000', accountName: 'Bank', balance: 500000, priorBalance: 400000, variance: 100000 }],
  liabilities: [{ accountCode: '2000', accountName: 'Creditors', balance: 200000, priorBalance: 250000, variance: -50000 }],
  equity: [{ accountCode: '3000', accountName: 'Retained income', balance: 270000, priorBalance: 150000, variance: 120000 }],
  totalAssets: 500000, totalLiabilities: 200000, totalEquity: 270000,
  priorTotalAssets: 400000, priorTotalLiabilities: 250000, priorTotalEquity: 150000,
};

describe('toBalanceSheetRows', () => {
  it('splits assets from liabilities and equity, each with its total', () => {
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: false });
    expect(assets.map(r => r.label)).toEqual(['Assets', 'Bank', 'Total Assets']);
    expect(liabilitiesAndEquity.map(r => r.label)).toEqual([
      'Liabilities', 'Creditors', 'Total Liabilities', 'Equity', 'Retained income', 'Total Equity', 'Total Liabilities and Equity',
    ]);
  });

  it('Total Liabilities and Equity is the only derived figure and equals L + E', () => {
    const { liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: false });
    const le = liabilitiesAndEquity.find(r => r.id === 'grand:totalLiabilitiesAndEquity')!;
    expect(le.actual).toBe(R.totalLiabilities + R.totalEquity);
    expect(le.actual).not.toBe(R.totalAssets); // the fixture does not balance
    expect(le.kind).toBe('grand');
  });

  it('carries prior balances only when comparative', () => {
    const on = toBalanceSheetRows(R, { comparative: true }).assets.find(r => r.accountCode === '1000')!;
    const off = toBalanceSheetRows(R, { comparative: false }).assets.find(r => r.accountCode === '1000')!;
    expect(on.prior).toBe(400000); expect(off.prior).toBeUndefined();
  });

  it('colours the band subtotals the same way as the income statement does', () => {
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: true });
    // Assets up 400000 → 500000: favourable. Liabilities down 250000 → 200000:
    // favourable. Equity up 150000 → 270000 is a claim going UP: unfavourable
    // by the same convention incomeStatementRows applies.
    expect(assets.find(r => r.id === 'sub:assets')?.favourable).toBe(true);
    expect(liabilitiesAndEquity.find(r => r.id === 'sub:liabilities')?.favourable).toBe(true);
    expect(liabilitiesAndEquity.find(r => r.id === 'sub:equity')?.favourable).toBe(false);
  });

  it('says so when a section has no lines, rather than showing a bare header', () => {
    const empty = { ...R, assets: [], totalAssets: 0, liabilities: [], totalLiabilities: 0, equity: [], totalEquity: 0 };
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(empty, { comparative: false });
    expect(assets.map(r => r.label)).toContain('No asset balances');
    expect(liabilitiesAndEquity.map(r => r.label)).toContain('No liability balances');
    expect(liabilitiesAndEquity.map(r => r.label)).toContain('No equity balances');
  });

  it('a liability going down is favourable; an asset going up is favourable', () => {
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: true });
    expect(assets.find(r => r.accountCode === '1000')?.favourable).toBe(true);
    expect(liabilitiesAndEquity.find(r => r.accountCode === '2000')?.favourable).toBe(true);
  });
});
