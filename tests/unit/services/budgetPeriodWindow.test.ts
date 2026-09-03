/**
 * The month window a Budget vs Actual run should sum.
 *
 * The report used `for (let m = startMonth; m <= endMonth; m++)` over
 * `Date.getMonth()`, which only holds while a fiscal year starts in January.
 * Every company in production does start in January, so that loop happened to
 * work — but it breaks the moment a fiscal year starts anywhere else: the bound
 * goes backwards, the loop runs zero times, and the report shows R0.00 of
 * budget against real actuals, which looks exactly like "nobody set a budget".
 * Month-ordinal arithmetic holds for either convention.
 *
 * Month keys are derived from the 'YYYY-MM-DD' strings directly. No Date
 * arithmetic: a UTC rollback on a month boundary would silently shift the
 * window by a month.
 */
import { describe, it, expect } from 'vitest';
import {
  budgetMonthKeysInWindow,
  currentMonthWindow,
  sumBudgetForWindow,
} from '@/modules/accounting/services/reports/budgetPeriodWindow';

describe('budgetMonthKeysInWindow', () => {
  it('covers a calendar-year window', () => {
    expect(budgetMonthKeysInWindow('2026-01-01', '2026-12-31')).toEqual([
      'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
    ]);
  });

  it('walks across the year boundary of a March–February fiscal year', () => {
    expect(budgetMonthKeysInWindow('2026-03-01', '2027-02-28')).toEqual([
      'mar','apr','may','jun','jul','aug','sep','oct','nov','dec','jan','feb',
    ]);
  });

  it('a year-to-date window that has crossed into January is not empty', () => {
    expect(budgetMonthKeysInWindow('2026-03-01', '2027-01-18')).toEqual([
      'mar','apr','may','jun','jul','aug','sep','oct','nov','dec','jan',
    ]);
  });

  it('a single month is one key', () => {
    expect(budgetMonthKeysInWindow('2026-09-01', '2026-09-30')).toEqual(['sep']);
  });

  it('never runs past twelve months', () => {
    expect(budgetMonthKeysInWindow('2020-01-01', '2030-12-31')).toHaveLength(12);
  });

  it('an end before the start yields nothing rather than a wrapped year', () => {
    expect(budgetMonthKeysInWindow('2026-06-01', '2026-05-31')).toEqual([]);
  });
});

describe('sumBudgetForWindow', () => {
  const perMonth = {
    jan: 100, feb: 100, mar: 100, apr: 100, may: 100, jun: 100,
    jul: 100, aug: 100, sep: 100, oct: 100, nov: 100, dec: 100,
  };

  it('sums only the months inside the window', () => {
    expect(sumBudgetForWindow(perMonth, 1200, ['mar','apr','may'])).toBe(300);
  });

  it('accepts the 0-based numeric keys older rows were written with', () => {
    const byIndex = { '0': 5, '1': 7, '2': 11 };
    expect(sumBudgetForWindow(byIndex, 0, ['jan','feb'])).toBe(12);
  });

  it('keeps a deliberate zero month rather than falling back to the annual', () => {
    const withZero = { ...perMonth, mar: 0 };
    expect(sumBudgetForWindow(withZero, 1200, ['mar'])).toBe(0);
  });

  it('pro-rates the annual amount only when no monthly split was ever stored', () => {
    expect(sumBudgetForWindow({}, 1200, ['mar','apr','may'])).toBe(300);
  });

  it('reports no budget when there is neither a split nor an annual amount', () => {
    expect(sumBudgetForWindow({}, 0, ['mar','apr','may'])).toBe(0);
  });
});

// `new Date(y, m, 1).toISOString()` is local midnight rendered as UTC. In SAST
// (UTC+2) that is 22:00 on the LAST DAY OF THE PREVIOUS MONTH, so the window
// the report called "this month" opened a day early and pulled in a day of the
// previous month's actuals. The same slice on `now` moves the end date back a
// day for any run between midnight and 02:00 local.
describe('currentMonthWindow', () => {
  it('opens on the first of the local month, not the last day of the previous one', () => {
    // 2026-09-01 00:30 SAST — 2026-08-31T22:30Z.
    const now = new Date('2026-08-31T22:30:00.000Z');
    expect(currentMonthWindow(now)).toEqual({ startDate: '2026-09-01', endDate: '2026-09-01' });
  });

  it('ends on the local day, not the UTC one, just after local midnight', () => {
    // 2026-09-15 01:00 SAST — 2026-09-14T23:00Z.
    const now = new Date('2026-09-14T23:00:00.000Z');
    expect(currentMonthWindow(now)).toEqual({ startDate: '2026-09-01', endDate: '2026-09-15' });
  });

  it('crosses a year boundary on the local calendar', () => {
    // 2027-01-01 00:30 SAST — 2026-12-31T22:30Z.
    const now = new Date('2026-12-31T22:30:00.000Z');
    expect(currentMonthWindow(now)).toEqual({ startDate: '2027-01-01', endDate: '2027-01-01' });
  });

  it('is stable mid-day, where UTC and local agree on the date', () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    expect(currentMonthWindow(now)).toEqual({ startDate: '2026-09-01', endDate: '2026-09-15' });
  });
});
