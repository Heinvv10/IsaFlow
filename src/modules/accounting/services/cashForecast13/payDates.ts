/**
 * The company's pay dates inside the horizon (ruling 2026-11-16): monthly on the pay day, moved back to
 * Friday when it falls on a weekend (backToFriday, the SARS calendar's rule). A pay day past a short month's
 * end is that month's last day first. The pay day is the company's stored setting (payDaySetting), 25 when none is chosen.
 * Pure.
 */
import { backToFriday, lastDayOf } from '@/modules/bureau/services/vatPeriodHelper';
import { addMonthsToMonth } from './weeks';

export type PayDay = number | 'last_working_day';

/** The pay date of month 'YYYY-MM': the pay day (a short month's last day when past it), back to Friday. */
export function payDateOf(payDay: PayDay, month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = lastDayOf(y, m);
  return backToFriday(y, m, payDay === 'last_working_day' ? last : Math.min(payDay, last));
}

/** `paidMonths`: 'YYYY-MM' periods whose run is already paid — no second payment that month. */
export function payDatesInHorizon(payDay: PayDay, today: string, horizonEnd: string, paidMonths: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let month = today.slice(0, 7); month <= horizonEnd.slice(0, 7); month = addMonthsToMonth(month, 1)) {
    const date = payDateOf(payDay, month);
    if (date >= today && date <= horizonEnd && !paidMonths.has(month)) out.push(date);
  }
  return out;
}
