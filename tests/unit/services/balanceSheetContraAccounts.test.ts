/**
 * Debit-normal equity and liability accounts (Dividends Declared, Drawings, a VAT-input control kept on the liability
 * side) are contra accounts: their debit balance REDUCES equity / liabilities. The balance sheet reported them with
 * their own normal-side sign and ADDED them, so equity was overstated by twice the dividends and the sheet stopped
 * balancing (isaflow_dev, 2026-10-07: Sample Trading's 3400 Dividends Declared R2,534,865.85 -> equity off by
 * R5,069,731.70; tests/unit/mcp/w2/equityBases caught it).
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown>>;
const mockGetSystemAccount = getSystemAccount as MockedFunction<typeof getSystemAccount>;
const RE_ACCOUNT = { id: 're', accountCode: '3900', accountName: 'Retained Earnings', accountType: 'equity', accountSubtype: 'retained_earnings' };

const row = (account_code: string, account_type: string, normal_balance: string, total_debit: number, total_credit: number) =>
  ({ account_code, account_name: account_code, account_type, normal_balance, total_debit, total_credit });

async function sheetFor(glRows: unknown[], revenue: number, expenses: number) {
  mockSql.mockResolvedValueOnce(glRows).mockResolvedValueOnce([{ revenue, expenses }]);
  mockGetSystemAccount.mockResolvedValue(RE_ACCOUNT as Awaited<ReturnType<typeof getSystemAccount>>);
  return getBalanceSheet('00000000-0000-0000-0000-0000000000c1', '2026-12-31');
}

describe('balance sheet: debit-normal equity and liability accounts are contra accounts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('Dividends Declared (equity, debit-normal) reduces equity and the sheet balances', async () => {
    // Bank 30,000 = Payables 5,000 + (Capital 15,000 - Dividends 10,000 + profit 20,000)
    const report = await sheetFor([
      row('1000', 'asset', 'debit', 30000, 0),
      row('2000', 'liability', 'credit', 0, 5000),
      row('3000', 'equity', 'credit', 0, 15000),
      row('3400', 'equity', 'debit', 10000, 0),
    ], 20000, 0);
    expect(report.equity.find((e) => e.accountCode === '3400')!.balance).toBeCloseTo(-10000, 2);
    expect(report.totalEquity).toBeCloseTo(25000, 2);
    expect(report.totalAssets).toBeCloseTo(report.totalLiabilities + report.totalEquity, 2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a debit-normal liability with a debit balance reduces liabilities; with a credit balance it adds', async () => {
    // Bank 27,000 = (Payables 5,000 - VAT input 3,000) + (Capital 15,000 + profit 10,000)
    const debitSide = await sheetFor([
      row('1000', 'asset', 'debit', 27000, 0),
      row('2000', 'liability', 'credit', 0, 5000),
      row('2200', 'liability', 'debit', 3000, 0),
      row('3000', 'equity', 'credit', 0, 15000),
    ], 10000, 0);
    expect(debitSide.totalLiabilities).toBeCloseTo(2000, 2);
    expect(debitSide.totalAssets).toBeCloseTo(debitSide.totalLiabilities + debitSide.totalEquity, 2);

    // The same control account in net credit (VAT payable 4,000): Bank 34,000 = (5,000 + 4,000) + 25,000
    const creditSide = await sheetFor([
      row('1000', 'asset', 'debit', 34000, 0),
      row('2000', 'liability', 'credit', 0, 5000),
      row('2200', 'liability', 'debit', 1000, 5000),
      row('3000', 'equity', 'credit', 0, 15000),
    ], 10000, 0);
    expect(creditSide.totalLiabilities).toBeCloseTo(9000, 2);
    expect(creditSide.totalAssets).toBeCloseTo(creditSide.totalLiabilities + creditSide.totalEquity, 2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('contra-assets are unchanged: accumulated depreciation (asset, credit-normal) still reduces assets', async () => {
    const report = await sheetFor([
      row('1500', 'asset', 'debit', 100000, 0),
      row('1510', 'asset', 'credit', 0, 40000),
      row('3000', 'equity', 'credit', 0, 60000),
    ], 0, 0);
    expect(report.totalAssets).toBeCloseTo(60000, 2);
    expect(report.totalAssets).toBeCloseTo(report.totalLiabilities + report.totalEquity, 2);
  });
});
