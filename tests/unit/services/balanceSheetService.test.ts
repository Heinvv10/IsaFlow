/**
 * BL-06: Unit tests for balanceSheetService.ts
 *
 * These tests verify that:
 * 1. getBalanceSheet returns populated asset/liability/equity sections when
 *    the retained_earnings system account is correctly configured (post-migration).
 * 2. The service does NOT throw when the call succeeds.
 * 3. The retained earnings calculator feeds the correct equity line.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { sql } from '@/lib/neon';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockGetSystemAccount = getSystemAccount as MockedFunction<typeof getSystemAccount>;

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'; // Brightsphere (post-migration)
const AS_AT_DATE = '2026-02-28';

const RE_ACCOUNT = {
  id: 'sys11-id',
  accountCode: 'SYS11',
  accountName: 'Retained Income',
  accountType: 'equity',
  accountSubtype: 'retained_earnings',
};

// GL rows returned by the main BS query
const BALANCE_SHEET_GL_ROWS = [
  // An asset account
  {
    account_code: '1000',
    account_name: 'Bank',
    account_type: 'asset',
    normal_balance: 'debit',
    total_debit: 50000,
    total_credit: 10000,
  },
  // A liability account
  {
    account_code: '2000',
    account_name: 'Trade Payables',
    account_type: 'liability',
    normal_balance: 'credit',
    total_debit: 5000,
    total_credit: 20000,
  },
  // An equity account (share capital)
  {
    account_code: '3000',
    account_name: 'Share Capital',
    account_type: 'equity',
    normal_balance: 'credit',
    total_debit: 0,
    total_credit: 15000,
  },
];

// Retained-earnings computation row (revenue 20000, expenses 5000 → net 15000)
const RE_CALC_ROW = [{ revenue: 20000, expenses: 5000 }];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('balanceSheetService — post-migration correctness (BL-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns populated asset, liability, and equity sections without throwing', async () => {
    // First sql call = fetchBalanceSheetData main query
    // Second sql call = calculateRetainedEarnings
    mockSql
      .mockResolvedValueOnce(BALANCE_SHEET_GL_ROWS)
      .mockResolvedValueOnce(RE_CALC_ROW);

    mockGetSystemAccount.mockResolvedValue(RE_ACCOUNT as ReturnType<typeof mockGetSystemAccount> extends Promise<infer R> ? R : never);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    // Should not throw — returns a valid report
    expect(report).toBeDefined();
    expect(report.asAtDate).toBe(AS_AT_DATE);

    // Assets section should have one entry (Bank, net debit 40000)
    expect(report.assets).toHaveLength(1);
    expect(report.assets[0]!.accountCode).toBe('1000');
    expect(report.assets[0]!.balance).toBeCloseTo(40000, 2);

    // Liabilities section
    expect(report.liabilities).toHaveLength(1);
    expect(report.liabilities[0]!.accountCode).toBe('2000');
    expect(report.liabilities[0]!.balance).toBeCloseTo(15000, 2);

    // Equity section should include Share Capital + Retained Earnings (current)
    expect(report.equity.length).toBeGreaterThanOrEqual(2);
    const reLine = report.equity.find(e => e.accountCode === 'SYS11' || e.accountName.includes('Retained'));
    expect(reLine).toBeDefined();
    expect(reLine!.balance).toBeCloseTo(15000, 2); // revenue 20000 - expenses 5000

    // Totals
    expect(report.totalAssets).toBeCloseTo(40000, 2);
  });

  it('uses the retained_earnings system account from systemAccountResolver', async () => {
    mockSql
      .mockResolvedValueOnce(BALANCE_SHEET_GL_ROWS)
      .mockResolvedValueOnce(RE_CALC_ROW);

    mockGetSystemAccount.mockResolvedValue(RE_ACCOUNT as ReturnType<typeof mockGetSystemAccount> extends Promise<infer R> ? R : never);

    await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    expect(mockGetSystemAccount).toHaveBeenCalledWith('retained_earnings', COMPANY_ID);
  });

  it('throws (and re-throws) when retained_earnings system account is missing', async () => {
    // Returns rows so calculateRetainedEarnings finds non-zero earnings
    mockSql
      .mockResolvedValueOnce(BALANCE_SHEET_GL_ROWS)
      .mockResolvedValueOnce(RE_CALC_ROW);

    // Simulate the pre-migration Brightsphere state: no retained_earnings account
    mockGetSystemAccount.mockRejectedValue(
      new Error("System account with subtype 'retained_earnings' not found for company d27bac33")
    );

    await expect(getBalanceSheet(COMPANY_ID, AS_AT_DATE)).rejects.toThrow(
      /retained_earnings/
    );
  });

  it('returns zero-balance equity when there are no GL journal lines (empty company)', async () => {
    mockSql
      .mockResolvedValueOnce([])               // no GL rows
      .mockResolvedValueOnce([{ revenue: 0, expenses: 0 }]); // zero RE

    // RE account resolver won't be called (retained earnings < 0.01)
    mockGetSystemAccount.mockResolvedValue(RE_ACCOUNT as ReturnType<typeof mockGetSystemAccount> extends Promise<infer R> ? R : never);

    const report = await getBalanceSheet(COMPANY_ID, AS_AT_DATE);

    expect(report.assets).toHaveLength(0);
    expect(report.liabilities).toHaveLength(0);
    expect(report.equity).toHaveLength(0);
    expect(report.totalAssets).toBe(0);
    expect(report.totalLiabilities).toBe(0);
    expect(report.totalEquity).toBe(0);
  });
});
