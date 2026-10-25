/**
 * COMPILE-TIME PROOF that a date formatter cannot be handed a number. It has no runtime behaviour and
 * is never imported; `bun run type-check` executes it (tests/** is outside tsconfig, so a proof there
 * would never be checked; same arrangement as src/lib/apiRoutes.typeproof.ts).
 *
 * A mechanical sweep once passed counts, quantities and totals to formatDisplayDateTime, and a pageview
 * count rendered as "01 Jan 1970, 02:00". Each `@ts-expect-error` below is such a call: if the input type
 * is ever widened to `number` (or `unknown`/`any`) the directive becomes unused and type-check fails (TS2578).
 */
import {
  formatDateISO, formatDateTimeISO, formatDisplayDate, formatDisplayDateLong, formatDisplayDateTime,
  formatDisplayMonthYear, formatDisplayTime,
} from '@/utils/dateFormat';

const count: number = 1234;

export const proofs = [
  // @ts-expect-error a count is not a date
  formatDisplayDate(count),
  // @ts-expect-error a quantity is not a date
  formatDisplayDateTime(count),
  // @ts-expect-error epoch milliseconds go in as new Date(ms)
  formatDisplayDateLong(Date.now()),
  // @ts-expect-error not a date
  formatDisplayMonthYear(count),
  // @ts-expect-error not a date
  formatDisplayTime(count),
  // @ts-expect-error not a date
  formatDateISO(count),
  // @ts-expect-error not a date
  formatDateTimeISO(count),
  // what IS accepted
  formatDisplayDate(new Date(Date.now())),
  formatDisplayDate('2026-10-21'),
  formatDisplayDate(null),
  formatDisplayDate(undefined),
];
