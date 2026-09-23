/**
 * Month <-> date-range helpers for the invoice list period control.
 *
 * A month is a UI convenience only: it becomes an inclusive `from`/`to` pair
 * and the API never sees it. Everything is string arithmetic on YYYY-MM-DD —
 * the dates are compared against a pg DATE column, so there is no instant and
 * no timezone to get wrong (a `toISOString()` here would shift SAST midnight
 * back into the previous day).
 */

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `2026-06` → `{ from: '2026-06-01', to: '2026-06-30' }`; null for anything else. */
export function monthRange(yearMonth: string): { from: string; to: string } | null {
  const m = MONTH.exec(yearMonth);
  if (!m) return null;
  const last = lastDayOf(Number(m[1]), Number(m[2]));
  return { from: `${yearMonth}-01`, to: `${yearMonth}-${String(last).padStart(2, '0')}` };
}

/** The YYYY-MM the range covers exactly, or null when it is not one whole month. */
export function wholeMonthOf(from: string, to: string): string | null {
  const f = DAY.exec(from);
  if (!f || !DAY.test(to)) return null;
  const range = monthRange(`${f[1]}-${f[2]}`);
  return range && range.from === from && range.to === to ? `${f[1]}-${f[2]}` : null;
}

/** The current month in the viewer's local calendar, as YYYY-MM. */
export function currentMonth(today: Date = new Date()): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}
