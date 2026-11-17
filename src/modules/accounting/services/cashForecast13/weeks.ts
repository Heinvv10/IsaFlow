/**
 * The forecast's calendar: 13 Monday-to-Sunday weeks, week 1 holding today. Pure date arithmetic on
 * 'YYYY-MM-DD' strings in UTC, so the server's own zone never moves a day.
 */
import { addDaysISO } from '@/lib/dateUtils';
import { FORECAST_WEEKS } from './types';

export { addDaysISO as addDays };

/** 0 = Monday … 6 = Sunday. */
export function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM' shifted by `n` months. */
export function addMonthsToMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export interface WeekSpan { index: number; start: string; end: string }

export function buildWeeks(today: string): WeekSpan[] {
  const first = addDaysISO(today, -isoWeekday(today));
  return Array.from({ length: FORECAST_WEEKS }, (_, i) => ({
    index: i,
    start: addDaysISO(first, 7 * i),
    end: addDaysISO(first, 7 * i + 6),
  }));
}

/**
 * The week a date falls in: a date before today lands in week 1 (index 0) — overdue money is expected now,
 * not in the past — and a date after the last Sunday is outside the forecast (null).
 */
export function weekIndexOf(date: string, today: string, weeks: readonly WeekSpan[]): number | null {
  const effective = date < today ? today : date;
  const first = weeks[0] as WeekSpan;
  const last = weeks[weeks.length - 1] as WeekSpan;
  if (effective > last.end) return null;
  return Math.floor(daysBetween(first.start, effective) / 7);
}
