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
  journalYearOf, lockNumberYears, orderByPredictedYears, YearKeyCursor, YearSpanTooWideError,
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

describe('journalYearOf is the trigger\'s EXTRACT(YEAR FROM entry_date) (sec-numrace S2)', () => {
  it('counts every year digit and negates a BC date', () => {
    expect(journalYearOf('2026-01-05')).toBe(2026);
    expect(journalYearOf('100000-01-01')).toBe(100000);
    expect(journalYearOf('101999-06-30')).toBe(101999);
    expect(journalYearOf('0044-03-15 BC')).toBe(-44);
    expect(journalYearOf('not a date')).toBeNaN();
  });

  it('2000 distinct 6-digit years are 2000 years to the cap, not 2', async () => {
    await expect(lockNumberYears('c1', Array.from({ length: 2000 }, (_, i) => journalYearOf(`${100000 + i}-01-01`))))
      .rejects.toBeInstanceOf(YearSpanTooWideError);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('ordered lazy: orderByPredictedYears + YearKeyCursor', () => {
  it('orders by min predicted year, stable on ties, undated last', () => {
    const items = [{ id: 'a', ys: [2026] }, { id: 'b', ys: [2025, 2027] }, { id: 'c', ys: [] }, { id: 'd', ys: [2025] }];
    expect(orderByPredictedYears(items, (x) => x.ys).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('refuses a run whose reach (multi-year ranges filled) exceeds 20 years, before any lock', () => {
    expect(() => orderByPredictedYears([{ ys: [2000, 2021] }], (x) => x.ys)).toThrow(YearSpanTooWideError);
    expect(orderByPredictedYears([{ ys: [2000, 2019] }], (x) => x.ys)).toHaveLength(1);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('a single-year element takes nothing; a multi-year one takes its whole range ascending, once', async () => {
    const cursor = new YearKeyCursor('c1');
    await cursor.before([2025]);
    expect(sqlMock).not.toHaveBeenCalled();
    await cursor.before([2027, 2025]);
    await cursor.before([2026, 2028]);
    expect(locked().map((l) => l[1])).toEqual(['2025', '2026', '2027', '2028']);
  });
});

describe('the "today" a reversal is predicted with is the posting path\'s (blind LOW3)', () => {
  // One original dated 2025-06-20 in a CLOSED period, no VAT lock: its contra is dated today, so the prediction is
  // TODAY's year — which flips exactly at SAST midnight, as resolveReversalDateDetailed's.
  const predictAt = async (instant: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    sqlMock
      .mockResolvedValueOnce([{ id: 'je1', entry_date: '2025-06-20', late_claim_of_id: null }])
      .mockResolvedValueOnce([{ fiscal_year: 2025, start_date: '2025-06-01', end_date: '2025-06-30', status: 'closed' }])
      .mockResolvedValueOnce([]);
    return { today: postingToday(), years: ((await predictReversalYears('c1', ['je1'])).get('je1') ?? []).sort() };
  };

  it('31 Dec 23:30 SAST is still 2025; 1 Jan 00:30 SAST is 2026 (UTC is still 31 Dec)', async () => {
    expect(await predictAt('2025-12-31T21:30:00Z')).toEqual({ today: '2025-12-31', years: [2025] });
    expect(await predictAt('2025-12-31T22:30:00Z')).toEqual({ today: '2026-01-01', years: [2026] });
    expect(journalYearOf(postingToday())).toBe(2026);
  });
});
