/**
 * P6 PR C: the pure folds from database rows to engine input (P&L by band,
 * actuals per month, the lookback, opening buckets and per-type totals).
 */
import { describe, expect, it } from 'vitest';
import { foldActuals, foldOpening, foldPnl, toLookback, type OpeningAccountRow } from '@/modules/accounting/services/budgets/threeWay/threeWayFolds';
import { bucketSum } from '@/modules/accounting/services/budgets/threeWay/balanceSheet';

describe('foldPnl', () => {
  it('sums every row (every grain) of a band per month, in cents; months outside the version are ignored', () => {
    const months = ['2026-03', '2026-04'];
    const out = foldPnl([
      { accountType: 'revenue', accountSubtype: null, month: '2026-03', amount: 100.1 },
      { accountType: 'revenue', accountSubtype: 'sales', month: '2026-03', amount: 0.2 },
      { accountType: 'revenue', accountSubtype: 'other_income', month: '2026-04', amount: 5 },
      { accountType: 'expense', accountSubtype: 'salaries', month: '2026-04', amount: 40 },
      { accountType: 'expense', accountSubtype: 'rent', month: '2026-04', amount: 7.5 },
      { accountType: 'expense', accountSubtype: 'tax', month: '2026-05', amount: 999 },
    ], months);
    expect(out[0]).toMatchObject({ turnover: 10030, otherIncome: 0 });
    expect(out[1]).toMatchObject({ otherIncome: 500, payroll: 4000, otherOpex: 750, taxExpense: 0 });
  });
});

describe('foldActuals + toLookback', () => {
  it('every month listed (absent = 0, inactive), supplier purchases = cost of sales + other opex', () => {
    const a = foldActuals([
      { accountType: 'revenue', accountSubtype: null, month: '2026-01', amount: 1000 },
      { accountType: 'expense', accountSubtype: 'cost_of_sales', month: '2026-01', amount: 400 },
      { accountType: 'expense', accountSubtype: null, month: '2026-01', amount: 100 },
      { accountType: 'expense', accountSubtype: 'payroll_expense', month: '2026-01', amount: 300 },
    ], ['2025-12', '2026-01']);
    expect(a.map((m) => [m.month, m.active])).toEqual([['2025-12', false], ['2026-01', true]]);
    expect(toLookback(a)).toEqual([
      { month: '2025-12', turnover: 0, costOfSales: 0, supplierPurchases: 0 },
      { month: '2026-01', turnover: 100000, costOfSales: 40000, supplierPurchases: 50000 },
    ]);
  });
});

describe('foldOpening', () => {
  const rows: OpeningAccountRow[] = [
    { accountId: 'bank', accountCode: '1000', accountType: 'asset', accountSubtype: 'bank', netDebit: 50000 },
    { accountId: 'ar', accountCode: '1100', accountType: 'asset', accountSubtype: 'receivable', netDebit: 20000 },
    { accountId: 'odd', accountCode: '1900', accountType: 'asset', accountSubtype: null, netDebit: 1000 },
    { accountId: 'ap', accountCode: '2000', accountType: 'liability', accountSubtype: 'payable', netDebit: -15000 },
    { accountId: 'loan', accountCode: '2500', accountType: 'liability', accountSubtype: null, netDebit: -30000 },
    { accountId: 're', accountCode: '3100', accountType: 'equity', accountSubtype: 'equity', netDebit: -6000 },
    { accountId: 'cap', accountCode: '3000', accountType: 'equity', accountSubtype: 'share_capital', netDebit: -10000 },
  ];
  // Derived RE (revenue less expenses to date): 10 000 credit.
  const f = foldOpening(rows, 10000, new Set(['loan']), 're');

  it('buckets balance (assets − liabilities − equity = 0) with derived RE in retained earnings', () => {
    expect(bucketSum(f.buckets)).toBe(0);
    expect(f.buckets).toMatchObject({ cash: 50000, receivables: 20000, otherCurrentAssets: 1000, payables: -15000, loans: -30000, shareCapital: -10000, retainedEarnings: -16000 });
  });

  it('per-type totals are getBalanceSheet’s natural-sign totals (equity includes derived RE)', () => {
    expect(f.totals).toEqual({ assets: 71000, liabilities: 45000, equity: 26000 });
  });

  it('lists only unclaimed accounts as unmapped (the loan account is claimed by its loan)', () => {
    expect(f.unmapped).toEqual([{ accountCode: '1900', bucket: 'otherCurrentAssets', balance: 1000 }]);
    expect([...f.cashAccounts.entries()]).toEqual([['bank', { accountCode: '1000', balance: 50000 }]]);
  });
});

describe('foldPnl range', () => {
  it('a figure beyond NUMERIC(15,2) is the engine’s typed RANGE refusal, never a bare RangeError', () => {
    expect(() => foldPnl([{ accountType: 'revenue', accountSubtype: null, month: '2026-03', amount: 1e14 }], ['2026-03']))
      .toThrow(expect.objectContaining({ name: 'EngineInputError', code: 'RANGE' }));
  });
});
