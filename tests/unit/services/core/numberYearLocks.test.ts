/**
 * NUMRACE: the pure half of core/numberYearLocks.ts and gl/journalReversalYears.ts — which year keys a run takes,
 * in what order, which rows it claims first, the 20-year cap, and the "today" a reversal is predicted with. The
 * locks themselves are proved against Postgres in tests/integration/numrace-*.int.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.TZ = 'Africa/Johannesburg';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]) }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));

import { postingToday } from '@/lib/fmtDate';
import {
  claimRowsThenLockYears, journalYearOf, lockNumberYears, YearSpanTooWideError,
} from '@/modules/accounting/services/core/numberYearLocks';
import { predictReversalYears } from '@/modules/accounting/services/gl/journalReversalYears';

/** The (company, suffix, seed) of every take_number_lock call, in call order. */
const locked = () => sqlMock.mock.calls.map((call) => (call as unknown[]).slice(1));

afterEach(() => { sqlMock.mockReset(); sqlMock.mockImplementation(async () => []); vi.useRealTimers(); });

describe('lockNumberYears', () => {
  it('takes every distinct year ascending, whatever order the run walks them in', async () => {
    await lockNumberYears('c1', [2026, 2024, 2026, 2025]);
    expect(locked()).toEqual([['c1', '2024', 857], ['c1', '2025', 857], ['c1', '2026', 857]]);
  });

  it('takes nothing for a single-year run, or for undated input', async () => {
    await lockNumberYears('c1', [2026, 2026]);
    await lockNumberYears('c1', [Number.NaN, 2026]);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses more than 20 distinct years before taking any lock', async () => {
    await expect(lockNumberYears('c1', Array.from({ length: 21 }, (_, i) => 2000 + i)))
      .rejects.toBeInstanceOf(YearSpanTooWideError);
    expect(sqlMock).not.toHaveBeenCalled();
    await lockNumberYears('c1', Array.from({ length: 20 }, (_, i) => 2000 + i));
    expect(sqlMock).toHaveBeenCalledTimes(20);
  });
});

describe('claimRowsThenLockYears', () => {
  it('claims the rows in walk order, THEN takes the years ascending', async () => {
    const order: string[] = [];
    sqlMock.mockImplementation(async (...a: unknown[]) => { order.push(`year ${String(a[2])}`); return []; });
    await claimRowsThenLockYears('c1', [{ id: 'b', years: [2026] }, { id: 'a', years: [2025] }],
      async (id) => { order.push(`row ${id}`); });
    expect(order).toEqual(['row b', 'row a', 'year 2025', 'year 2026']);
  });

  it('a single-year run claims nothing and takes nothing; a held row is left to the run, its year still taken', async () => {
    const claim = vi.fn(async () => undefined);
    await claimRowsThenLockYears('c1', [{ id: 'a', years: [2026] }], claim);
    expect(claim).not.toHaveBeenCalled();
    const held = Object.assign(new Error('held'), { code: 'BANK_TX_LOCK_TIMEOUT' });
    await claimRowsThenLockYears('c1', [{ id: 'a', years: [2025] }], async () => { throw held; }, [2026]);
    expect(locked().map((l) => l[1])).toEqual(['2025', '2026']);
  });

  it('a non-contention failure while claiming propagates', async () => {
    await expect(claimRowsThenLockYears('c1', [{ id: 'a', years: [2025, 2026] }], async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
  });
});

describe('the "today" a reversal is predicted with is the posting path\'s (blind LOW3)', () => {
  // One original dated 2025-12-20 in an open December period, no VAT lock: its contra is dated 2025-12-20, so the
  // prediction is that year plus TODAY's — which flips exactly at SAST midnight, as resolveReversalDateDetailed's.
  const predictAt = async (instant: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    sqlMock
      .mockResolvedValueOnce([{ entry_date: '2025-12-20', companion: false }])
      .mockResolvedValueOnce([{ fiscal_year: 2025, start_date: '2025-12-01', end_date: '2025-12-31', status: 'open' }])
      .mockResolvedValueOnce([]);
    return { today: postingToday(), years: (await predictReversalYears('c1', ['je1'])).sort() };
  };

  it('31 Dec 23:30 SAST is still 2025; 1 Jan 00:30 SAST is 2026 (UTC is still 31 Dec)', async () => {
    expect(await predictAt('2025-12-31T21:30:00Z')).toEqual({ today: '2025-12-31', years: [2025] });
    expect(await predictAt('2025-12-31T22:30:00Z')).toEqual({ today: '2026-01-01', years: [2025, 2026] });
    expect(journalYearOf(postingToday())).toBe(2026);
  });
});
