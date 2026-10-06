/**
 * NUMRACE: the pure half of core/numberYearLocks.ts — which year keys a run takes, and in what order. The locks
 * themselves are proved against Postgres in tests/integration/numrace-cross-year*.int.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn(async () => []) }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { journalYearOf, lockNumberYears, reversalYears } from '@/modules/accounting/services/core/numberYearLocks';

/** The scope argument of every take_number_lock call, in call order. */
const lockedSuffixes = () => sqlMock.mock.calls.map((call) => (call as unknown[]).slice(1));

describe('lockNumberYears', () => {
  afterEach(() => { sqlMock.mockClear(); vi.useRealTimers(); });

  it('takes every distinct year ascending, whatever order the run walks them in', async () => {
    await lockNumberYears('c1', [2026, 2024, 2026, 2025]);
    expect(lockedSuffixes()).toEqual([['c1', '2024', 857], ['c1', '2025', 857], ['c1', '2026', 857]]);
  });

  it('takes nothing for a single-year run, or for undated input', async () => {
    await lockNumberYears('c1', [2026, 2026]);
    await lockNumberYears('c1', [Number.NaN, 2026]);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('journalYearOf / reversalYears', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads the year of a date string or a pg DATE, and NaN for none', () => {
    expect(journalYearOf('2025-12-31')).toBe(2025);
    expect(journalYearOf(new Date(2026, 0, 1))).toBe(2026);
    expect(journalYearOf(null)).toBeNaN();
  });

  it('a named reversal date is its one year', () => {
    expect(reversalYears(['2019-03-01', '2026-01-01'], '2026-02-01')).toEqual([2026]);
  });

  it('otherwise spans the earliest original to the later of the latest original and today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 6));
    expect(reversalYears(['2025-12-20', '2026-01-20'])).toEqual([2025, 2026]);
    expect(reversalYears(['2024-06-01'])).toEqual([2024, 2025, 2026]);
    expect(reversalYears(['2027-01-05'])).toEqual([2027]);
    expect(reversalYears([null])).toEqual([]);
  });
});
