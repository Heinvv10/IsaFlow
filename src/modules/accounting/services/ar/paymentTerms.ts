/**
 * The due date a customer's payment terms give an invoice date. `days`: the invoice date + N. `end_of_month`: the last
 * day of the invoice month + N (CustomerForm's "End of the current Month"). Null when the terms give no date: no terms,
 * a negative or fractional number of days, a type this file does not know (the column is free text), or an invoice
 * date that is not a real 'YYYY-MM-DD'.
 *
 * Local-date arithmetic only: `toISOString()` rolls the date back a day east of UTC. Pure, safe in a client bundle.
 */
import { addDaysISO, localDateFromISO, monthEndISO } from '@/lib/dateUtils';

export function dueDateFromTerms(invoiceDateIso: string, days: number | null | undefined, type: string | null | undefined): string | null {
  const invoiceDate = localDateFromISO(invoiceDateIso);
  if (invoiceDate === null || days === null || days === undefined || !Number.isInteger(days) || days < 0) return null;
  if (type === 'days') return addDaysISO(invoiceDateIso, days);
  if (type === 'end_of_month') return addDaysISO(monthEndISO(invoiceDate), days);
  return null;
}
