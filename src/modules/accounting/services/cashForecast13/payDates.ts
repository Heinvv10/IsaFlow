/**
 * The company's pay dates inside the horizon (ruling 2026-11-16): monthly on the pay day, moved back to
 * Friday when it falls on a weekend (backToFriday, the SARS calendar's rule). A pay day past a short month's
 * end is that month's last day first. The pay day setting arrives with PR 2; until then the reader passes 25.
 * Pure.
 */
import { backToFriday, lastDayOf } from '@/modules/bureau/services/vatPeriodHelper';
import { addMonthsToMonth } from './weeks';

export type PayDay = number | 'last_working_day';

/** `paidMonths`: 'YYYY-MM' periods whose run is already paid — no second payment that month. */
export function payDatesInHorizon(payDay: PayDay, today: string, horizonEnd: string, paidMonths: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let month = today.slice(0, 7); month <= horizonEnd.slice(0, 7); month = addMonthsToMonth(month, 1)) {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const last = lastDayOf(y, m);
    const date = backToFriday(y, m, payDay === 'last_working_day' ? last : Math.min(payDay, last));
    if (date >= today && date <= horizonEnd && !paidMonths.has(month)) out.push(date);
  }
  return out;
}
