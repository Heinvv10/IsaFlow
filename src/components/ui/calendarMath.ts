/**
 * Pure calendar arithmetic for the DateField popup, all on 'YYYY-MM-DD' strings (never a Date across a zone).
 * Weeks are Monday-first (South African usage). Keys follow the W3C APG date picker dialog.
 */
import { addDaysISO, localDateFromISO, shiftYearISO } from '@/lib/dateUtils';

export interface YearMonth { year: number; month: number }

const pad = (n: number): string => String(n).padStart(2, '0');

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(iso: string): number {
  const d = localDateFromISO(iso);
  return d ? (d.getDay() + 6) % 7 : 0;
}

/** Always 42 cells (6 Monday-first weeks) covering the month, so the popup keeps one height. */
export function monthGrid(year: number, month: number): string[] {
  const first = `${String(year).padStart(4, '0')}-${pad(month)}-01`;
  const start = addDaysISO(first, -weekdayIndex(first));
  return Array.from({ length: 42 }, (_, i) => addDaysISO(start, i));
}

export function shiftMonth(ym: YearMonth, by: number): YearMonth {
  const idx = ym.year * 12 + (ym.month - 1) + by;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Same day next/previous month, clamped to the month's last day (31 Jan + 1 month = 28 Feb). */
export function addMonthsISO(iso: string, by: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = shiftMonth({ year: y, month: m }, by);
  const last = new Date(t.year, t.month, 0).getDate();
  return `${String(t.year).padStart(4, '0')}-${pad(t.month)}-${pad(Math.min(d, last))}`;
}

/** Where focus goes for an APG key, or null when the key is not the calendar's. */
export function moveByKey(iso: string, key: string, shift: boolean): string | null {
  switch (key) {
    case 'ArrowLeft': return addDaysISO(iso, -1);
    case 'ArrowRight': return addDaysISO(iso, 1);
    case 'ArrowUp': return addDaysISO(iso, -7);
    case 'ArrowDown': return addDaysISO(iso, 7);
    case 'Home': return addDaysISO(iso, -weekdayIndex(iso));
    case 'End': return addDaysISO(iso, 6 - weekdayIndex(iso));
    case 'PageUp': return shift ? shiftYearISO(iso, -1) : addMonthsISO(iso, -1);
    case 'PageDown': return shift ? shiftYearISO(iso, 1) : addMonthsISO(iso, 1);
    default: return null;
  }
}

export function clampToBounds(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const monthName = (month: number): string => MONTHS[month - 1] ?? '';

export function monthLabel(year: number, month: number): string {
  return `${monthName(month)} ${year}`;
}

/** Mon … Sun, two letters + full names for the column headers. */
export const WEEKDAYS: ReadonlyArray<{ short: string; full: string }> = DAYS.map((full) => ({ short: full.slice(0, 2), full }));
