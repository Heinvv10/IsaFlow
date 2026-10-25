/**
 * Which budget months a Budget vs Actual window covers.
 *
 * Budgets are stored per CALENDAR month (`budget_month_amounts.month`, the
 * first of the month; migration 944), so a window's budget is the sum of the
 * stored months from the window's first month to its last, whatever financial
 * year(s) they fall in. A financial year can be 1-15 months long after a
 * change of year end, so nothing here knows a year is twelve months, or
 * names months: a window of 14 months has 14 keys.
 *
 * A month is counted whole. A window that opens or closes mid-month still
 * takes that month's full budget, as the report always has.
 *
 * Dates arrive as 'YYYY-MM-DD' strings and are treated as strings throughout:
 * constructing a Date to read its month risks a UTC rollback moving a
 * first-of-the-month boundary into the previous month.
 */

import { localISODate } from '@/lib/dateUtils';

/** Months since year 0 — an orderable scalar that survives a year boundary. */
function monthOrdinal(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!match) return null;
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

/** 'YYYY-MM' for a month ordinal. */
function keyOfOrdinal(ordinal: number): string {
  const year = Math.floor(ordinal / 12);
  return `${String(year).padStart(4, '0')}-${String((ordinal % 12) + 1).padStart(2, '0')}`;
}

/** The 'YYYY-MM' months from `startDate` to `endDate` inclusive, in order; empty when the end precedes the start. */
export function budgetMonthKeysInWindow(startDate: string, endDate: string): string[] {
  const start = monthOrdinal(startDate);
  const end = monthOrdinal(endDate);
  if (start === null || end === null || end < start) return [];
  const keys: string[] = [];
  for (let o = start; o <= end; o++) keys.push(keyOfOrdinal(o));
  return keys;
}

/** `key` ('YYYY-MM') moved by `count` months (negative moves back). */
export function addMonthsToKey(key: string, count: number): string {
  const ordinal = monthOrdinal(key);
  if (ordinal === null) throw new Error(`addMonthsToKey: invalid month ${key}`);
  return keyOfOrdinal(ordinal + count);
}

/** The first-of-month date a 'YYYY-MM' key is stored under in budget_month_amounts. */
export function monthKeyToDate(key: string): string {
  return `${key}-01`;
}

/**
 * The first and last stored month dates ('YYYY-MM-01') a window covers, for a
 * `month BETWEEN first AND last` predicate; null when the window is empty.
 */
export function budgetMonthBounds(startDate: string, endDate: string): { first: string; last: string } | null {
  const keys = budgetMonthKeysInWindow(startDate, endDate);
  if (keys.length === 0) return null;
  return { first: monthKeyToDate(keys[0]!), last: monthKeyToDate(keys[keys.length - 1]!) };
}

export interface BudgetWindow {
  /** Inclusive first day of the window, 'YYYY-MM-DD'. */
  startDate: string;
  /** Inclusive last day of the window, 'YYYY-MM-DD'. */
  endDate: string;
}

/**
 * The current month to date, on the LOCAL calendar.
 *
 * `new Date(y, m, 1).toISOString()` renders local midnight as UTC, which in
 * SAST (UTC+2) is 22:00 on the last day of the previous month — so the window
 * opened a day early and swept in a day of the previous month's actuals. The
 * same slice applied to `now` moved the end date back a day on any run between
 * local midnight and 02:00. Both are read off the local calendar instead.
 */
export function currentMonthWindow(now: Date = new Date()): BudgetWindow {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return {
    startDate: `${year}-${month}-01`,
    endDate: localISODate(now),
  };
}
