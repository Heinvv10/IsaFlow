import { describe, it, expect } from 'vitest';
import { toBalanceSheetRows } from '@/components/accounting/statement/balanceSheetRows';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.report.types';

const R: BalanceSheetReport = {
  asAtDate: '2026-08-31',
  assets: [{ accountCode: '1000', accountName: 'Bank', balance: 500000, priorBalance: 400000, variance: 100000 }],
  liabilities: [{ accountCode: '2000', accountName: 'Creditors', balance: 200000, priorBalance: 250000, variance: -50000 }],
  equity: [{ accountCode: '3000', accountName: 'Retained income', balance: 300000, priorBalance: 150000, variance: 150000 }],
  totalAssets: 500000, totalLiabilities: 200000, totalEquity: 300000,
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
    expect(le.kind).toBe('grand');
  });

  it('carries prior balances only when comparative', () => {
    const on = toBalanceSheetRows(R, { comparative: true }).assets.find(r => r.accountCode === '1000')!;
    const off = toBalanceSheetRows(R, { comparative: false }).assets.find(r => r.accountCode === '1000')!;
    expect(on.prior).toBe(400000); expect(off.prior).toBeUndefined();
  });

  it('a liability going down is favourable; an asset going up is favourable', () => {
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: true });
    expect(assets.find(r => r.accountCode === '1000')?.favourable).toBe(true);
    expect(liabilitiesAndEquity.find(r => r.accountCode === '2000')?.favourable).toBe(true);
  });
});
