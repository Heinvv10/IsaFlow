/**
 * Unit tests for changesInEquityService.ts
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

const OPENING_ROWS = [
  { account_subtype: 'share_capital',     balance: 100000 },
  { account_subtype: 'share_premium',     balance: 50000  },
  { account_subtype: 'retained_earnings', balance: 30000  },
  { account_subtype: 'revaluation',       balance: 5000   },
];

const MOVEMENTS_ROWS = [
  { account_subtype: 'retained_earnings', movement_type: 'profit',      amount: 20000 },
  { account_subtype: 'retained_earnings', movement_type: 'dividend',    amount: -8000 },
  { account_subtype: 'share_capital',     movement_type: 'share_issue', amount: 10000 },
  { account_subtype: 'share_premium',     movement_type: 'share_issue', amount: 40000 },
  { account_subtype: 'revaluation',       movement_type: 'revaluation', amount: 3000  },
];

describe('changesInEquityService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a matrix with correct opening balances', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(MOVEMENTS_ROWS);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);

    const sc = result.columns.find(c => c.subtype === 'share_capital')!;
    expect(sc.opening).toBeCloseTo(100000, 2);
    expect(sc.shareIssue).toBeCloseTo(10000, 2);
    expect(sc.closing).toBeCloseTo(110000, 2);
  });

  it('calculates retained earnings movements correctly', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(MOVEMENTS_ROWS);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    const re = result.columns.find(c => c.subtype === 'retained_earnings')!;
    expect(re.opening).toBeCloseTo(30000, 2);
    expect(re.profitForYear).toBeCloseTo(20000, 2);
    expect(re.dividends).toBeCloseTo(-8000, 2);
    expect(re.closing).toBeCloseTo(42000, 2);
  });

  it('calculates total equity column correctly', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(MOVEMENTS_ROWS);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.totalOpening).toBeCloseTo(185000, 2);
    expect(result.totalClosing).toBeCloseTo(250000, 2);
  });

  it('returns zero equity when there are no GL lines', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.columns).toHaveLength(0);
    expect(result.totalOpening).toBe(0);
    expect(result.totalClosing).toBe(0);
  });

  it('logs error and re-throws on DB failure', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    await expect(
      getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('connection refused');
  });
});
