/**
 * The comparative period for a report, computed on the CALENDAR.
 *
 * Pure, and it takes and returns 'YYYY-MM-DD' strings. That is the point: the
 * income-statement page computed its comparative like this —
 *
 *   const durationMs = end.getTime() - start.getTime();
 *   const priorEnd   = new Date(start.getTime() - 1);
 *   const priorStart = new Date(priorEnd.getTime() - durationMs);
 *   params.set('compare_start', priorStart.toISOString().split('T')[0]);
 *
 * — and got two things wrong in four lines. It is a ROLLING WINDOW, not a prior
 * period: March is 31 days, so it compares against 29 January – 28 February and
 * February never appears as itself. And `toISOString()` renders in UTC on a
 * UTC+2 host, so a boundary before 02:00 SAST reports the previous day, which
 * is a defect class this repo has been bitten by repeatedly.
 *
 * No Date is constructed here at all, so there is nothing to render and no
 * timezone to render it in.
 */

/** A 'YYYY-MM-DD' window. */
export interface PeriodWindow {
  start: string;
  end: string;
}

function parts(date: string): { y: number; m: number; d: number } {
  return {
    y: Number(date.slice(0, 4)),
    m: Number(date.slice(5, 7)),
    d: Number(date.slice(8, 10)),
  };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function iso(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Days in a month, with the Gregorian leap rule. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01 for a 'YYYY-MM-DD'. Integer arithmetic, no Date. */
function toDayNumber(date: string): number {
  const { y, m, d } = parts(date);
  // Howard Hinnant's days_from_civil. Exact for every date in range, and it
  // never involves a timestamp, so it cannot shift by a timezone.
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of `toDayNumber`. */
function fromDayNumber(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return iso(m <= 2 ? y + 1 : y, m, d);
}

/** True when the window is exactly N whole calendar months. */
function wholeMonths(start: string, end: string): number | null {
  const s = parts(start);
  const e = parts(end);
  if (s.d !== 1) return null;
  if (e.d !== daysInMonth(e.y, e.m)) return null;
  const months = (e.y - s.y) * 12 + (e.m - s.m) + 1;
  return months > 0 ? months : null;
}

/**
 * The period immediately before this one.
 *
 * A window of whole calendar months maps to the SAME NUMBER of whole calendar
 * months immediately before it — March to February, Q2 to Q1 — so the
 * comparison is like for like and the prior period appears as itself. Anything
 * else has no calendar predecessor and falls back to the immediately preceding
 * window of the same length, which the caller should label as such rather than
 * present as "last month".
 */
export function priorPeriod(start: string, end: string): PeriodWindow {
  const months = wholeMonths(start, end);
  if (months !== null) {
    const s = parts(start);
    // Zero-based month arithmetic so the year rolls without a special case.
    const zeroBased = (s.y * 12 + (s.m - 1)) - months;
    const priorStartYear = Math.floor(zeroBased / 12);
    const priorStartMonth = (zeroBased % 12) + 1;
    const zeroEnd = zeroBased + months - 1;
    const priorEndYear = Math.floor(zeroEnd / 12);
    const priorEndMonth = (zeroEnd % 12) + 1;
    return {
      start: iso(priorStartYear, priorStartMonth, 1),
      end: iso(priorEndYear, priorEndMonth, daysInMonth(priorEndYear, priorEndMonth)),
    };
  }
  const length = toDayNumber(end) - toDayNumber(start);
  const priorEnd = toDayNumber(start) - 1;
  return { start: fromDayNumber(priorEnd - length), end: fromDayNumber(priorEnd) };
}

/**
 * The same window one year earlier.
 *
 * 29 February is clamped to the 28th: 2025-02-29 does not exist, Postgres
 * throws 22008 on the cast, and a `Date` would roll it forward to 1 March and
 * compare a window nobody asked for.
 */
export function priorYearPeriod(start: string, end: string): PeriodWindow {
  const shift = (date: string): string => {
    const { y, m, d } = parts(date);
    return iso(y - 1, m, Math.min(d, daysInMonth(y - 1, m)));
  };
  return { start: shift(start), end: shift(end) };
}
