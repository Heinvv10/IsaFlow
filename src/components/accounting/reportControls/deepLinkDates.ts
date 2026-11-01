import { localDateFromISO } from '@/lib/dateUtils';

/**
 * The From/To of a deep link. DateField throws on a bound that is not a real YYYY-MM-DD, so one must never reach
 * it; a link with a corrupt date in it is ignored whole (both dates), and the page falls back to the open period.
 */
export function deepLinkDates(query: Record<string, string | string[] | undefined>): { qStart: string; qEnd: string } {
  const start = typeof query.period_start === 'string' ? query.period_start : '';
  const end = typeof query.period_end === 'string' ? query.period_end : '';
  const real = (v: string): boolean => v === '' || localDateFromISO(v) !== null;
  return real(start) && real(end) ? { qStart: start, qEnd: end } : { qStart: '', qEnd: '' };
}
