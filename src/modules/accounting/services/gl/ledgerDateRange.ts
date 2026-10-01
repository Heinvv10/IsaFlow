/**
 * The dates a ledger listing accepts. The year-end walk (fiscalYearCloseRows) and its
 * per-fiscal-year SQL scale with the span, so a date must be a real 'YYYY-MM-DD' calendar
 * date inside a sane year range. `typeof` comes first: a repeated query parameter arrives
 * as an array and must never reach a string method.
 */

import { isRealCalendarDate } from '@/lib/validation';

export const LEDGER_MIN_YEAR = 1900;
export const LEDGER_MAX_YEAR = 2200;

export const LEDGER_DATE_MESSAGE =
  `must be a real date, YYYY-MM-DD, with a year from ${LEDGER_MIN_YEAR} to ${LEDGER_MAX_YEAR}`;

/** Refuse before any SQL: a date outside the ledger range reaches a ::date cast as a 22008 that poisons the transaction. */
export function assertLedgerDates(...dates: unknown[]): void {
  for (const d of dates) {
    if (!isLedgerDate(d)) throw new Error(`invalid ledger date '${String(d)}': ${LEDGER_DATE_MESSAGE}`);
  }
}

/** assertLedgerDates plus: the range must not be inverted. */
export function assertLedgerRange(from: unknown, to: unknown): void {
  assertLedgerDates(from, to);
  if ((from as string) > (to as string)) throw new Error(`invalid ledger range: ${String(from)} is after ${String(to)}`);
}

/** A plain non-negative integer in [min, max] from a query parameter, else null. `typeof` first: a repeated parameter is an array. */
export function parseBoundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

export function isLedgerDate(value: unknown): value is string {
  if (typeof value !== 'string' || !isRealCalendarDate(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= LEDGER_MIN_YEAR && year <= LEDGER_MAX_YEAR;
}
