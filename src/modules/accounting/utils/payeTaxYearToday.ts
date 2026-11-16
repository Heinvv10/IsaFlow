/** The PAYE tax year (labelled by the year it ends in) holding today's date in South Africa. Client-safe. */
import { todayInSast } from '@/lib/saDateParser';
import { payeTaxYearOf } from './payeTaxYear';

export function currentPayeTaxYear(now: Date = new Date()): number {
  const today = todayInSast(now);
  return payeTaxYearOf(Number(today.slice(5, 7)), Number(today.slice(0, 4)));
}
