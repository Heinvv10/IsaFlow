/**
 * When open customer invoices are expected to be paid (ruling 2026-11-16). Pure.
 *   - Not yet due (due ≥ today): the due date, basis 'due'.
 *   - Overdue, customer with ≥ 3 paid invoices in the last 12 months: due + the customer's median days late,
 *     basis 'history' (a projection still before today is left dated; the engine puts it in week 1).
 *   - Overdue, fewer than 3: today (week 1), basis 'no_history'.
 * Disputed amounts are left out of the receipt, as the aging leaves them out of its buckets, and reported.
 */
import type { KnownItem, OverdueArSummary, ArBasis } from './types';
import { addDays } from './weeks';

export const MIN_PAID_FOR_HISTORY = 3;

export interface OpenArInvoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  /** COALESCE(due_date, invoice_date, created_at) — the aging fetcher's due date. */
  dueDate: string;
  balanceCents: number;
  disputedCents: number;
}

/** The median of whole days; an even count takes the mean of the middle two, rounded half up. */
export function medianDaysLate(samples: readonly number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function expected(inv: OpenArInvoice, samples: readonly number[] | undefined, today: string): { date: string; basis: ArBasis } {
  if (inv.dueDate >= today) return { date: inv.dueDate, basis: 'due' };
  if (samples && samples.length >= MIN_PAID_FOR_HISTORY) return { date: addDays(inv.dueDate, medianDaysLate(samples)), basis: 'history' };
  return { date: today, basis: 'no_history' };
}

/** `daysLate`: per customer, days late (paid − due) of each paid invoice in the last 12 months. */
export function arItems(
  invoices: readonly OpenArInvoice[], daysLate: ReadonlyMap<string, readonly number[]>, today: string,
): { items: KnownItem[]; summary: OverdueArSummary } {
  const summary: OverdueArSummary = { totalCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };
  const items: KnownItem[] = [];
  for (const inv of invoices) {
    summary.disputedCents += inv.disputedCents;
    const amount = inv.balanceCents - inv.disputedCents;
    if (amount <= 0) continue;
    const { date, basis } = expected(inv, daysLate.get(inv.customerId), today);
    if (basis !== 'due') {
      summary.totalCents += amount;
      summary.invoiceCount += 1;
      summary.byBasis[basis] += amount;
    }
    items.push({
      lineKey: `ar:${inv.customerId}:${basis}`, lineLabel: inv.customerName, category: 'customer_receipts',
      date, amountCents: amount, ref: inv.id, refLabel: inv.invoiceNumber, basis,
      ...(basis === 'no_history' ? { flags: ['no_history'] } : {}),
    });
  }
  return { items, summary };
}
