/**
 * When the next run of a recurring template falls due.
 *
 * Its own module, and pure, because the arithmetic is where the bugs are and a
 * DB-free module can be unit-tested against the calendar directly.
 */

/** Days in `month` (1-12) of `year`, leap years included. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Advance `dateStr` (YYYY-MM-DD) by one interval of `frequency`.
 *
 * The month-length cases are the whole point. `new Date('2026-01-31')` then
 * `setMonth(+1)` overflows February and lands on 3 March, so a template on the
 * 31st skipped February and drifted to the 3rd for the rest of its life — and
 * because the run is claimed on `next_run_date` and the journal is DATED at it,
 * that drift landed in the general ledger, not only in the schedule.
 *
 * Two rules, in this order:
 *
 * 1. **Clamp.** A day the target month does not have becomes that month's last
 *    day: 31 January + 1 month is 28 February, or 29 in a leap year.
 * 2. **Month end is sticky.** A date that IS the last day of its month advances
 *    to the last day of the target month: 28 February + 1 month is 31 March,
 *    31 August + 1 month is 30 September. Without this the anchor day is lost
 *    at the first clamp and a month-end template slides permanently onto the
 *    28th.
 *
 * The stickiness is an inference, and it has one knowable cost: the table
 * stores no anchor day, so a template deliberately scheduled on the 28th in a
 * NON-leap February is indistinguishable from one clamped there from the 30th
 * or 31st, and both advance to 31 March. Month-end is the accounting
 * convention for a monthly accrual, so that is the side to be wrong on; giving
 * a template its own anchor day needs a column and a migration.
 */
/**
 * How far one interval of each supported frequency moves the date, in months.
 *
 * A Map, not an object literal: `frequency` arrives as a plain `string` off a
 * DB row, and an object index resolves 'constructor' and 'toString' on the
 * prototype — neither `undefined` nor a number, so the arithmetic below would
 * produce an Invalid Date and return the string 'NaN-NaN-NaN' as a run date.
 */
const MONTHS_PER_INTERVAL = new Map<string, number>([
  ['monthly', 1],
  ['quarterly', 3],
  ['annually', 12],
]);

export function advanceDate(dateStr: string, frequency: string): string {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];

  if (frequency === 'weekly') {
    const d = new Date(Date.UTC(year, month - 1, day + 7));
    return d.toISOString().slice(0, 10);
  }

  const monthsToAdd = MONTHS_PER_INTERVAL.get(frequency);
  if (monthsToAdd === undefined) {
    // Throw, never fall through returning `dateStr`. The caller claims the run
    // with `next_run_date = <the returned date>`, so an unchanged date leaves
    // the claim predicate and the due-date guard both matching for ever and
    // every Generate mints another posted journal on the same day — the K-048
    // defect restored by the two guards written to close it. Unreachable while
    // the CHECK on recurring_journals.frequency (migration 206) and the
    // RecurringFrequency union hold; a 500 that rolls the request back is the
    // right answer the day one of them gains a value this function has not
    // been taught.
    throw new Error(`advanceDate: unsupported recurring frequency '${frequency}'`);
  }

  const target = new Date(Date.UTC(year, month - 1 + monthsToAdd, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  const lastDayOfTarget = daysInMonth(targetYear, targetMonth);

  const atMonthEnd = day === daysInMonth(year, month);
  const targetDay = atMonthEnd ? lastDayOfTarget : Math.min(day, lastDayOfTarget);

  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}
