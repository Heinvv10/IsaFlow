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

export function isLedgerDate(value: unknown): value is string {
  if (typeof value !== 'string' || !isRealCalendarDate(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= LEDGER_MIN_YEAR && year <= LEDGER_MAX_YEAR;
}
