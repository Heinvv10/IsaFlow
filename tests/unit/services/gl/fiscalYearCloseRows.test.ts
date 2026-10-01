import { describe, it, expect } from 'vitest';
import {
  closeRowAmounts,
  fiscalYearEndBefore,
  fiscalYearStartsWithin,
  runWithYearEndCloses,
} from '@/modules/accounting/services/gl/fiscalYearCloseRows';

describe('fiscalYearStartsWithin', () => {
  it('lists FY starts after fromDate and on or before toDate, ascending', () => {
    expect(fiscalYearStartsWithin('2024-05-01', '2026-06-30', 3)).toEqual(['2025-03-01', '2026-03-01']);
  });

  it('counts a boundary that falls exactly on toDate, not one exactly on fromDate', () => {
    expect(fiscalYearStartsWithin('2025-03-01', '2026-03-01', 3)).toEqual(['2026-03-01']);
  });

  it('is empty when the range sits inside one fiscal year, or is inverted', () => {
    expect(fiscalYearStartsWithin('2025-03-01', '2026-02-28', 3)).toEqual([]);
    expect(fiscalYearStartsWithin('2026-06-30', '2024-01-01', 3)).toEqual([]);
  });

  // A leading-space date used to loop forever: the space sorts below every digit, so the
  // string compare never went false while the year kept decrementing into garbage.
  it.each([' 2025-03-01', 'garbage', '', '2025-3-1', '20250301'])(
    'rejects the odd date %j instead of looping',
    (bad) => {
      expect(() => fiscalYearStartsWithin(bad, '2026-06-30', 3)).toThrow(/invalid date/);
      expect(() => fiscalYearStartsWithin('2024-01-01', bad, 3)).toThrow(/invalid date/);
    },
    5000,
  );

  it('accepts an ISO timestamp, as fiscalYearStart does', () => {
    expect(fiscalYearStartsWithin('2024-05-01T00:00:00.000Z', '2025-06-30T12:00:00Z', 3)).toEqual(['2025-03-01']);
  });

  it('terminates at year 0001 for the widest legal range', () => {
    expect(fiscalYearStartsWithin('0000-01-01', '0003-06-30', 3).length).toBeLessThanOrEqual(4);
  }, 5000);
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
