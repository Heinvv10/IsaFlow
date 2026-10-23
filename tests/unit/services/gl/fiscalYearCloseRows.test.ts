import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fiscalYearSqlFake, MARCH_YEARS, TRANSITION_YEARS, type FakeYear,
} from '../../../helpers/fiscalYearSqlFake';

const state = vi.hoisted(() => ({ sql: (async () => []) as (...a: unknown[]) => Promise<unknown[]> }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => state.sql(...a) }));

import {
  closeRowAmounts,
  fiscalYearEndBefore,
  fiscalYearStartsWithin,
  incomeStatementOpeningFloor,
  runWithYearEndCloses,
} from '@/modules/accounting/services/gl/fiscalYearCloseRows';

/** Drive the REAL registry reader through a fake of its database functions. */
function useYears(years: readonly FakeYear[], templateMonth?: number) {
  const fake = fiscalYearSqlFake(years, { templateMonth });
  state.sql = fake as unknown as typeof state.sql;
  return fake;
}

beforeEach(() => { useYears(MARCH_YEARS, 3); });

describe('fiscalYearStartsWithin', () => {
  it('lists FY starts after fromDate and on or before toDate, ascending', async () => {
    expect(await fiscalYearStartsWithin('c1', '2024-05-01', '2026-06-30')).toEqual(['2025-03-01', '2026-03-01']);
  });

  it('counts a boundary that falls exactly on toDate, not one exactly on fromDate', async () => {
    expect(await fiscalYearStartsWithin('c1', '2025-03-01', '2026-03-01')).toEqual(['2026-03-01']);
  });

  it('is empty when the range sits inside one fiscal year, or is inverted', async () => {
    expect(await fiscalYearStartsWithin('c1', '2025-03-01', '2026-02-28')).toEqual([]);
    expect(await fiscalYearStartsWithin('c1', '2026-06-30', '2024-01-01')).toEqual([]);
  });

  it('walks the REAL years: a 14-month transition year is one boundary, not two', async () => {
    useYears(TRANSITION_YEARS);
    // FY2027 runs 2026-01-01 to 2027-02-28; stepping a start month of March through it would
    // invent a 2026-03-01 boundary that is not a year start.
    expect(await fiscalYearStartsWithin('c1', '2025-06-01', '2027-06-30')).toEqual(['2026-01-01', '2027-03-01']);
  });

  it('keeps a past year on its stored dates after a change of year end', async () => {
    // The declared month is now March, yet FY2026 stays the calendar year it was.
    useYears(TRANSITION_YEARS, 1);
    expect(await fiscalYearStartsWithin('c1', '2024-12-31', '2025-12-31')).toEqual(['2025-01-01']);
  });

  // A leading-space date used to loop forever: the space sorts below every digit, so the
  // string compare never went false while the year kept decrementing into garbage.
  it.each([
    ' 2025-03-01', 'garbage', '', '2025-3-1', '2026-1-15', '20250301', '2025-02-31', '2025-13-01',
    '2025-03-01T00:00:00Z', '2025-03-01 ', '1000-01-01', '9999-12-31', '0000-01-01', '1899-12-31', '2201-01-01',
  ])('rejects the odd date %j instead of looping',
    async (bad) => {
      const fake = useYears(MARCH_YEARS, 3);
      await expect(fiscalYearStartsWithin('c1', bad, '2026-06-30')).rejects.toThrow(/invalid date/);
      await expect(fiscalYearStartsWithin('c1', '2024-01-01', bad)).rejects.toThrow(/invalid date/);
      // Refused before the registry is asked: a bad date must not reach SQL's date cast.
      expect(fake.calls).toEqual([]);
    },
    5000,
  );

  it.each([undefined, null, 20250301, ['2025-03-01'], {}])('rejects the non-string %j', async (bad) => {
    await expect(fiscalYearStartsWithin('c1', bad as unknown as string, '2026-06-30')).rejects.toThrow(/invalid date/);
    await expect(fiscalYearStartsWithin('c1', '2024-01-01', bad as unknown as string)).rejects.toThrow(/invalid date/);
  }, 5000);

  it('walks the widest legal range in one bounded pass', async () => {
    const all = await fiscalYearStartsWithin('c1', '1900-01-01', '2200-12-31');
    expect(all).toHaveLength(301);
    expect(all[0]).toBe('1900-03-01');
    expect(all[all.length - 1]).toBe('2200-03-01');
  }, 10000);
});

describe('incomeStatementOpeningFloor', () => {
  it('is the start of the registry year holding fromDate for a revenue or expense account', async () => {
    expect(await incomeStatementOpeningFloor('c1', 'revenue', '2025-09-15')).toBe('2025-03-01');
    expect(await incomeStatementOpeningFloor('c1', 'expense', '2026-02-28')).toBe('2025-03-01');
  });

  it('is the transition year\'s own start, not the start month re-applied', async () => {
    useYears(TRANSITION_YEARS);
    expect(await incomeStatementOpeningFloor('c1', 'revenue', '2027-02-10')).toBe('2026-01-01');
  });

  it('is null (no floor) for a balance-sheet account, without asking the registry', async () => {
    const fake = useYears(MARCH_YEARS, 3);
    expect(await incomeStatementOpeningFloor('c1', 'asset', '2025-09-15')).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe('fiscalYearEndBefore / closeRowAmounts', () => {
  it('ends the year the day before the next start, across a leap February', () => {
    expect(fiscalYearEndBefore('2024-03-01')).toBe('2024-02-29');
    expect(fiscalYearEndBefore('2025-01-01')).toBe('2024-12-31');
  });

  it('closes a normal-side balance with the opposite side', () => {
    expect(closeRowAmounts(100, 'credit')).toEqual({ debit: 100, credit: 0 });
    expect(closeRowAmounts(100, 'debit')).toEqual({ debit: 0, credit: 100 });
    expect(closeRowAmounts(-40, 'debit')).toEqual({ debit: 40, credit: 0 });
  });
});

describe('runWithYearEndCloses', () => {
  const makeClose = (fyEnd: string, a: { debit: number; credit: number }) => ({
    date: fyEnd, debit: a.debit, credit: a.credit, tag: 'close',
  });
  const run = (rows: Array<{ date: string; debit: number; credit: number; tag?: string }>, opening: number, boundaries: string[]) =>
    runWithYearEndCloses(rows, { opening, normalBalance: 'credit', boundaries, makeClose });

  it('puts a row dated exactly on a boundary AFTER the close, in the new year', () => {
    const { rows, closing } = run([{ date: '2025-02-10', debit: 0, credit: 50 }, { date: '2025-03-01', debit: 0, credit: 30 }], 0, ['2025-03-01']);
    expect(rows.map(r => [r.date, r.balance])).toEqual([['2025-02-10', 50], ['2025-02-28', 0], ['2025-03-01', 30]]);
    expect(rows[1]).toMatchObject({ tag: 'close', debit: 50, credit: 0 });
    expect(closing).toBe(30);
  });

  it('inserts no close for an empty year, and carries the opening into the first close', () => {
    const { rows, closing } = run([{ date: '2026-04-01', debit: 0, credit: 10 }], 25, ['2025-03-01', '2026-03-01']);
    // Opening 25 closes at the first boundary; the second year held nothing, so nothing to close.
    expect(rows.map(r => [r.date, r.balance])).toEqual([['2025-02-28', 0], ['2026-04-01', 10]]);
    expect(closing).toBe(10);
  });

  it('closes after the last row when a boundary follows every line', () => {
    const { rows, closing } = run([{ date: '2025-01-05', debit: 0, credit: 70 }], 0, ['2025-03-01']);
    expect(rows.map(r => [r.date, r.balance])).toEqual([['2025-01-05', 70], ['2025-02-28', 0]]);
    expect(closing).toBe(0);
  });

  it('adds nothing for an account with no movement and a zero opening', () => {
    expect(run([], 0, ['2025-03-01', '2026-03-01'])).toEqual({ rows: [], closing: 0 });
  });

  it('closes a non-zero opening even when the account has no lines', () => {
    const { rows, closing } = run([], 12.5, ['2025-03-01']);
    expect(rows).toEqual([{ date: '2025-02-28', debit: 12.5, credit: 0, tag: 'close', balance: 0 }]);
    expect(closing).toBe(0);
  });

  it('does not close a balance that rounds to zero', () => {
    expect(run([], 0.004, ['2025-03-01']).rows).toEqual([]);
  });
});
