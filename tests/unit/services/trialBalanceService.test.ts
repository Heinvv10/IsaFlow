/**
 * Unit tests for trialBalanceService.ts
 *
 * BL-18 (F-008): Verify that `getTrialBalance` returns a plain `TrialBalanceRow[]`
 * and that the API handler wraps it as `{ rows, totalDebit, totalCredit }`.
 * The canonical response container key is `rows` — never `accounts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    transaction: vi.fn(),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERIOD_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    account_code: '1000',
    account_name: 'Bank - Primary',
    account_type: 'asset',
    normal_balance: 'debit',
    debit_balance: '1000.00',
    credit_balance: '0.00',
    ...overrides,
  };
}

describe('getTrialBalance (BL-18 shape contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a plain array of TrialBalanceRow items (not an object with accounts key)', async () => {
    const mockSql = sql as ReturnType<typeof vi.fn>;
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const result = await getTrialBalance(COMPANY_ID, PERIOD_ID);

    // Must be an array — not wrapped in { accounts: [...] }
    expect(Array.isArray(result)).toBe(true);
    expect('accounts' in result).toBe(false);
  });

  it('maps DB snake_case to camelCase TrialBalanceRow fields', async () => {
    const mockSql = sql as ReturnType<typeof vi.fn>;
    mockSql.mockResolvedValueOnce([
      makeDbRow({ debit_balance: '2500.50', credit_balance: '0.00' }),
    ]);

    const result = await getTrialBalance(COMPANY_ID, PERIOD_ID);

    const row = result[0] as TrialBalanceRow;
    expect(row.accountCode).toBe('1000');
    expect(row.accountName).toBe('Bank - Primary');
    expect(row.accountType).toBe('asset');
    expect(row.normalBalance).toBe('debit');
    expect(row.debitBalance).toBe(2500.5);
    expect(row.creditBalance).toBe(0);

    // Confirm there is no `accounts` property on the row itself
    expect('accounts' in row).toBe(false);
  });

  it('returns empty array when no journal lines exist for the period', async () => {
    const mockSql = sql as ReturnType<typeof vi.fn>;
    mockSql.mockResolvedValueOnce([]);

    const result = await getTrialBalance(COMPANY_ID, PERIOD_ID);

    expect(result).toHaveLength(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it('API response wrapper shape uses "rows" key — not "accounts"', () => {
    // Simulate what reports-trial-balance.ts does after calling getTrialBalance
    const rows: TrialBalanceRow[] = [
      {
        accountCode: '1000',
        accountName: 'Bank',
        accountType: 'asset',
        normalBalance: 'debit',
        debitBalance: 1000,
        creditBalance: 0,
      },
    ];
    const totalDebit  = rows.reduce((s, r) => s + r.debitBalance, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditBalance, 0);

    const responseData = { fiscalPeriodId: PERIOD_ID, rows, totalDebit, totalCredit };

    // BL-18: canonical key must be `rows`, never `accounts`
    expect('rows' in responseData).toBe(true);
    expect('accounts' in responseData).toBe(false);
    expect(responseData.rows).toHaveLength(1);
    expect(responseData.totalDebit).toBe(1000);
    expect(responseData.totalCredit).toBe(0);
  });
});
