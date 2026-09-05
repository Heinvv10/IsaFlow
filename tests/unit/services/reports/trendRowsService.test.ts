/**
 * The shaping rules the integration test cannot isolate: what a month with no
 * row means on each of the two series.
 *
 * On the MOVEMENT series an absent month is zero — nothing was posted, so
 * nothing moved. On the BALANCE series an absent month is the month before it,
 * because a balance persists whether or not anyone touched the account. The
 * brief's sample tried to tell those apart by inspecting the returned rows,
 * which cannot work: once shaped, a real zero and an absent month are the same
 * number. Seeding a running sum with the balance at the window's open removes
 * the question, and these tests pin that a genuine zero balance still reads
 * zero rather than inheriting the month before it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));

// The retained-earnings suppression asks the resolver which account the
// balance sheet injects onto. Stubbed here so these tests stay about shaping.
const systemAccountMock = vi.fn();
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: (...a: unknown[]) => systemAccountMock(...a),
}));

import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import {
  monthKeys,
  getMonthlyMovements,
  getMonthlyBalances,
} from '@/modules/accounting/services/reports/trendRowsService';

const AS_OF = '2026-08-31';

beforeEach(() => {
  sqlMock.mockReset();
  systemAccountMock.mockReset();
  systemAccountMock.mockResolvedValue({ accountCode: '3200', accountName: 'Retained Earnings' });
});

describe('monthKeys', () => {
  it('gives the twelve months ending at the as-of month, oldest first', () => {
    expect(monthKeys(AS_OF)).toEqual([
      '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
    ]);
  });

  it('crosses the year boundary without drifting a month', () => {
    expect(monthKeys('2026-01-31')[0]).toBe('2025-02');
    expect(monthKeys('2026-01-31')[11]).toBe('2026-01');
  });
});

describe('getMonthlyMovements', () => {
  it('places each row in its month and leaves untouched months at zero', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '4000', month_key: '2025-11', amount: 1500 },
      { account_code: '4000', month_key: '2026-08', amount: '2500.50' },
    ]);
    const t = await getMonthlyMovements('c1', AS_OF);
    expect(t.byAccountCode['4000']).toEqual([
      0, 0, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 2500.5,
    ]);
  });

  it('ignores a row outside the twelve-month window', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '4000', month_key: '2024-01', amount: 999 },
      { account_code: '4000', month_key: '2026-08', amount: 10 },
    ]);
    const t = await getMonthlyMovements('c1', AS_OF);
    expect(t.byAccountCode['4000']).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10]);
  });
});

describe('getMonthlyBalances', () => {
  it('carries a balance forward through months with no posting', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: '2025-11', amount: 400 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']).toEqual([
      0, 0, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400,
    ]);
  });

  it('seeds the first month from the balance at the window open', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: 'opening', amount: 1000 },
      { account_code: '1100', month_key: '2026-03', amount: -250 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']).toEqual([
      1000, 1000, 1000, 1000, 1000, 1000, 750, 750, 750, 750, 750, 750,
    ]);
  });

  it('keeps a series for an account whose only activity predates the window', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: 'opening', amount: '750.25' },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']).toEqual(new Array(12).fill(750.25));
  });

  it('a balance that genuinely returns to zero reads zero, not the month before', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: '2025-10', amount: 500 },
      { account_code: '1100', month_key: '2025-12', amount: -500 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']).toEqual([
      0, 500, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('does not let one account’s balance leak into another’s series', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: 'opening', amount: 1000 },
      { account_code: '2100', month_key: '2026-02', amount: 300 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']).toEqual(new Array(12).fill(1000));
    expect(t.byAccountCode['2100']).toEqual([0, 0, 0, 0, 0, 300, 300, 300, 300, 300, 300, 300]);
  });
});

describe('accounts with no series', () => {
  it('leaves an account with no ledger activity out of byAccountCode entirely', async () => {
    sqlMock.mockResolvedValueOnce([{ account_code: '1100', month_key: '2026-02', amount: 300 }]);
    const balances = await getMonthlyBalances('c1', AS_OF);
    expect(Object.keys(balances.byAccountCode)).toEqual(['1100']);
    expect(balances.byAccountCode['1200']).toBeUndefined();

    sqlMock.mockResolvedValueOnce([{ account_code: '4000', month_key: '2026-02', amount: 300 }]);
    const movements = await getMonthlyMovements('c1', AS_OF);
    expect(Object.keys(movements.byAccountCode)).toEqual(['4000']);
    expect(movements.byAccountCode['5000']).toBeUndefined();
  });

  it('drops a balance series that never reaches a cent, as the balance sheet does', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: '2025-10', amount: 0.004 },
      { account_code: '1200', month_key: '2025-10', amount: 0.02 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']).toBeUndefined();
    expect(t.byAccountCode['1200']).toBeDefined();
  });

  it('keeps a series that is under a cent in some months but not all', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '1100', month_key: '2025-10', amount: 0.001 },
      { account_code: '1100', month_key: '2026-03', amount: 500 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['1100']![0]).toBe(0);
    expect(t.byAccountCode['1100']![11]).toBeCloseTo(500.001, 3);
  });
});

describe('retained earnings', () => {
  it('returns no series for it, and says why', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_code: '3200', month_key: 'opening', amount: 900000 },
      { account_code: '1100', month_key: '2026-02', amount: 300 },
    ]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.byAccountCode['3200']).toBeUndefined();
    expect(t.unavailable['3200']).toBe('derived on the balance sheet');
    expect(t.byAccountCode['1100']).toBeDefined();
  });

  it('flags it even when the account has no posted lines at all', async () => {
    sqlMock.mockResolvedValueOnce([{ account_code: '1100', month_key: '2026-02', amount: 300 }]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.unavailable['3200']).toBe('derived on the balance sheet');
  });

  it('flags nothing when the company has no retained-earnings account', async () => {
    systemAccountMock.mockRejectedValue(
      new MissingSystemAccountError('retained_earnings', 'c1', 'no_claimant', []),
    );
    sqlMock.mockResolvedValueOnce([{ account_code: '1100', month_key: '2026-02', amount: 300 }]);
    const t = await getMonthlyBalances('c1', AS_OF);
    expect(t.unavailable).toEqual({});
    expect(t.byAccountCode['1100']).toBeDefined();
  });

  it('lets an unrelated resolver failure through rather than guessing', async () => {
    systemAccountMock.mockRejectedValue(new Error('connection terminated'));
    sqlMock.mockResolvedValueOnce([{ account_code: '1100', month_key: '2026-02', amount: 300 }]);
    await expect(getMonthlyBalances('c1', AS_OF)).rejects.toThrow('connection terminated');
  });

  it('movements carry no unavailable entries — the P&L is all posted lines', async () => {
    sqlMock.mockResolvedValueOnce([{ account_code: '4000', month_key: '2026-02', amount: 300 }]);
    const t = await getMonthlyMovements('c1', AS_OF);
    expect(t.unavailable).toEqual({});
  });
});
