/**
 * The calendar months a Budget vs Actual window covers.
 *
 * Budgets are stored per calendar month (budget_month_amounts, migration 944),
 * so a window's budget is the sum of the months from its first month to its
 * last. Nothing here knows a financial year is twelve months: a 14-month
 * transition year is 14 keys, and a window that crosses any year boundary
 * is not empty.
 *
 * Month keys are derived from the 'YYYY-MM-DD' strings directly. No Date
 * arithmetic: a UTC rollback on a month boundary would silently shift the
 * window by a month.
 */
import { describe, it, expect } from 'vitest';
import {
  addMonthsToKey,
  budgetMonthBounds,
  budgetMonthKeysInWindow,
  currentMonthWindow,
  monthKeyToDate,
} from '@/modules/accounting/services/reports/budgetPeriodWindow';

describe('budgetMonthKeysInWindow', () => {
  it('covers a calendar-year window', () => {
    expect(budgetMonthKeysInWindow('2026-01-01', '2026-12-31')).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ]);
  });

  it('walks across the year boundary of a March-February financial year', () => {
    const keys = budgetMonthKeysInWindow('2026-03-01', '2027-02-28');
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2026-03');
    expect(keys[9]).toBe('2026-12');
    expect(keys[10]).toBe('2027-01');
    expect(keys[11]).toBe('2027-02');
  });

  it('a year-to-date window that has crossed into January is not empty', () => {
    expect(budgetMonthKeysInWindow('2026-03-01', '2027-01-18')).toHaveLength(11);
  });

  it('a single month is one key, whatever day the window opens and closes on', () => {
    expect(budgetMonthKeysInWindow('2026-09-01', '2026-09-30')).toEqual(['2026-09']);
    expect(budgetMonthKeysInWindow('2026-09-17', '2026-09-18')).toEqual(['2026-09']);
  });

  it('a 14-month transition year has 14 keys, the last two in the next calendar year', () => {
    const keys = budgetMonthKeysInWindow('2026-01-01', '2027-02-28');
    expect(keys).toHaveLength(14);
    expect(keys.slice(12)).toEqual(['2027-01', '2027-02']);
  });

  it('is not capped at twelve months', () => {
    expect(budgetMonthKeysInWindow('2020-01-01', '2030-12-31')).toHaveLength(132);
  });

  it('an end before the start yields nothing rather than a wrapped year', () => {
    expect(budgetMonthKeysInWindow('2026-06-01', '2026-05-31')).toEqual([]);
  });

  it('a malformed date yields nothing', () => {
    expect(budgetMonthKeysInWindow('soon', '2026-05-31')).toEqual([]);
  });
});

describe('budgetMonthBounds', () => {
  it('is the first of the first month to the first of the last month', () => {
    expect(budgetMonthBounds('2026-12-15', '2027-01-10')).toEqual({ first: '2026-12-01', last: '2027-01-01' });
  });

  it('is null for an empty window', () => {
    expect(budgetMonthBounds('2026-06-01', '2026-05-31')).toBeNull();
  });
});

describe('month key arithmetic', () => {
  it('moves across a year boundary in both directions', () => {
    expect(addMonthsToKey('2026-12', 1)).toBe('2027-01');
    expect(addMonthsToKey('2027-01', -1)).toBe('2026-12');
    expect(addMonthsToKey('2026-03', 14)).toBe('2027-05');
  });

  it('names the stored first-of-month date', () => {
    expect(monthKeyToDate('2027-02')).toBe('2027-02-01');
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
