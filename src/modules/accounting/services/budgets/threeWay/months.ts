/**
 * 'YYYY-MM' month arithmetic for the three-way engine (P6 §13.4: months are
 * 'YYYY-MM' strings end to end). Pure integer arithmetic: no `Date`, so no
 * timezone can move a month (spec R7).
 */

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True when `m` is a 'YYYY-MM' month string. */
export function isMonth(m: unknown): m is string {
  return typeof m === 'string' && MONTH_RE.test(m);
}

function parts(m: string): { y: number; mo: number } {
  const hit = MONTH_RE.exec(m);
  if (!hit) throw new RangeError(`Not a 'YYYY-MM' month: ${String(m)}`);
  return { y: Number(hit[1]), mo: Number(hit[2]) };
}

/** Months since year 0 — a total order where consecutive months differ by 1. */
export function monthOrdinal(m: string): number {
  const { y, mo } = parts(m);
  return y * 12 + (mo - 1);
}

function fromOrdinal(n: number): string {
  const y = Math.floor(n / 12);
  const mo = n - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`;
}

/** `m` shifted by `k` months (k may be negative). */
export function addMonths(m: string, k: number): string {
  return fromOrdinal(monthOrdinal(m) + k);
}

/** Calendar month number 1..12. */
export function monthNumber(m: string): number {
  return parts(m).mo;
}

/** Days in the month, leap-aware (Gregorian). */
export function daysInMonth(m: string): number {
  const { y, mo } = parts(m);
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
}

/** True when every month follows the previous one by exactly one month. */
export function isContiguous(months: readonly string[]): boolean {
  for (let i = 1; i < months.length; i++) {
    if (monthOrdinal(months[i] as string) !== monthOrdinal(months[i - 1] as string) + 1) return false;
  }
  return true;
}
