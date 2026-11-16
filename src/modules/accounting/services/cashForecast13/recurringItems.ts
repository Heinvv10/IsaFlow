/**
 * Expected receipts from active recurring invoice templates (ruling 2026-11-16): each run date from the
 * template's next run, repeating by its frequency (`advanceDate`, the runner's own) to its end date, is an
 * invoice; it is collected on that invoice's due date. A run date already passed is invoiced today, as the
 * runner dates a late run. Only receipts inside the horizon are returned. Pure.
 *
 * The due date is the RUNNER's (recurringInvoiceRun.ts): the customer's terms, else the company default —
 * the template's own `payment_terms` text is not read by the runner, so it is not read here either.
 */
import { advanceDate } from '@/modules/accounting/services/gl/recurringSchedule';
import type { KnownItem } from './types';

export interface RecurringTemplateRow {
  id: string;
  name: string;
  customerId: string;
  customerName: string;
  frequency: string;
  nextRunDate: string;
  endDate: string | null;
  totalCents: number;
}

export function recurringItems(
  templates: readonly RecurringTemplateRow[], today: string, horizonEnd: string, dueDateOf: (t: RecurringTemplateRow, invoiceDate: string) => string,
): KnownItem[] {
  const items: KnownItem[] = [];
  for (const t of templates) {
    if (t.totalCents <= 0) continue;
    for (let run = t.nextRunDate; run <= horizonEnd && (t.endDate === null || run <= t.endDate); run = advanceDate(run, t.frequency)) {
      const invoiceDate = run < today ? today : run;
      const due = dueDateOf(t, invoiceDate);
      if (due > horizonEnd) continue;
      items.push({
        lineKey: `recurring:${t.id}`, lineLabel: `${t.customerName} — ${t.name} (recurring)`, category: 'customer_receipts', entityId: t.customerId,
        date: due, amountCents: t.totalCents, ref: `${t.id}:${run}`, refLabel: `Run ${run}`,
      });
    }
  }
  return items;
}
