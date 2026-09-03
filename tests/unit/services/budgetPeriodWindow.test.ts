/**
 * The month window a Budget vs Actual run should sum.
 *
 * The report used `for (let m = startMonth; m <= endMonth; m++)` over
 * `Date.getMonth()`, which is a calendar-year assumption. Every company in this
 * system runs a March–February fiscal year, so the moment the year-to-date
 * window crosses into January the loop bound goes backwards, runs zero times,
 * and the report shows R0.00 of budget against real actuals — the failure mode
 * looks exactly like "nobody set a budget".
 *
 * Month keys are derived from the 'YYYY-MM-DD' strings directly. No Date
 * arithmetic: a UTC rollback on a month boundary would silently shift the
 * window by a month.
 */
import { describe, it, expect } from 'vitest';
import {
  budgetMonthKeysInWindow,
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
