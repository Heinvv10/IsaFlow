/**
 * Open AR and AP for the forecast, from the aging's own fetchers (one definition of "open"), plus each
 * customer's payment history.
 *
 * PAID DATE (census): an invoice's paid date is the latest `payment_date` of the customer receipts allocated
 * to it (customer_payment_allocations → customer_payments, status not draft/cancelled) — the datable
 * settlement the aging rewind uses (shared/agingRewind.ts). `paid_at` is not used: it is stamped NOW() when the
 * settlement is captured, not when the customer paid. An invoice settled with no receipt allocation (credit
 * note only, or a legacy amount_paid with no trail) has no paid date and does not count toward history.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import { fetchAPAgingInvoices } from '@/modules/accounting/services/ap/apAgingInvoices';
import { arItems } from './arExpected';
import { toCents } from './lines';
import type { KnownItem, OverdueArSummary } from './types';

/** Per customer, the days late (paid date − due date) of each fully paid invoice with a paid date in the 12 months to today. */
export async function readCustomerDaysLate(companyId: string, today: string): Promise<Map<string, number[]>> {
  const rows = (await sql`
    SELECT COALESCE(ci.client_id, ci.customer_id) AS customer_id,
           (paid.paid_date - COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date)) AS days_late
    FROM customer_invoices ci
    JOIN LATERAL (
      SELECT MAX(cp.payment_date) AS paid_date
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id AND cp.company_id = ${companyId}::UUID
      WHERE cpa.invoice_id = ci.id
        AND cp.status NOT IN ('draft', 'cancelled')
    ) paid ON paid.paid_date IS NOT NULL
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.status = 'paid'
      AND ci.deleted_at IS NULL
      AND paid.paid_date > (${today}::date - INTERVAL '12 months')::date
      AND paid.paid_date <= ${today}::date
    ORDER BY 1, 2
  `) as DbRow[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const id = String(r.customer_id);
    const list = out.get(id) ?? [];
    list.push(Number(r.days_late));
    out.set(id, list);
  }
  return out;
}

export async function readReceivables(companyId: string, today: string): Promise<{ items: KnownItem[]; summary: OverdueArSummary }> {
  const open = await fetchARAgingInvoices(companyId, today, today);
  const history = await readCustomerDaysLate(companyId, today);
  return arItems(open.map((i) => ({
    id: i.id, invoiceNumber: i.invoiceNumber, customerId: i.entityId, customerName: i.entityName, dueDate: i.dueDate,
    balanceCents: toCents(i.balance), disputedCents: toCents(i.disputedAmount ?? 0),
  })), history, today);
}

/** Open supplier bills by due date (a missing one is the bill date, as the aging dates it); overdue lands in week 1. */
export async function readPayables(companyId: string, today: string): Promise<KnownItem[]> {
  const open = await fetchAPAgingInvoices(companyId, today, today);
  return open.map((b) => ({
    lineKey: `ap:${b.entityId}`, lineLabel: b.entityName, category: 'supplier_payments' as const,
    date: b.dueDate, amountCents: -toCents(b.balance), ref: b.id, refLabel: b.invoiceNumber,
  }));
}
