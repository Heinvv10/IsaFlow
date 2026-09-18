/**
 * A customer's open invoices, in the order cash will consume them — the AR twin
 * of `ap/openSupplierBills`.
 *
 * `COALESCE(ci.client_id, ci.customer_id)` because both columns exist and
 * either can carry the customer; matching on one alone silently misses half the
 * ledger.
 *
 * `FOR UPDATE OF ci` and never a bare `FOR UPDATE`: the lock belongs to the
 * invoice rows this receipt is about to consume. See the AP twin's header for
 * why the lock is the caller's choice and why the four statements are written
 * out rather than assembled.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EPS } from '../shared/autoAllocateStrategy';
import type { SimulationDocument } from '../shared/autoApplySimulation';
import type { OpenDocumentFetchOptions } from '../ap/openSupplierBills';

/**
 * Statuses that cannot take a receipt — the set `receiptAllocationLines`
 * refuses on, plus the terminal ones.
 *
 * 'disputed' and 'written_off' are NOT in `customer_invoices`' CHECK constraint
 * (migration 000; a dispute lives in `customer_invoice_disputes` instead), so
 * neither ever matches a row. They are listed anyway so this array and its AP
 * twin say the same thing: two lists that disagree about what cash may settle
 * is how the two subledgers drift apart.
 */
export const UNALLOCATABLE_INVOICE_STATUSES = [
  'draft', 'pending_approval', 'cancelled', 'paid', 'written_off', 'disputed',
];

export async function fetchOpenCustomerInvoices(
  companyId: string,
  customerId: string,
  oldestFirst: boolean,
  opts: OpenDocumentFetchOptions,
): Promise<SimulationDocument[]> {
  const rows = (oldestFirst
    ? (opts.forUpdate
      ? await sql`
          SELECT ci.id, ci.invoice_number,
                 (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
          FROM customer_invoices ci
          WHERE ci.company_id = ${companyId}::UUID
            AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
            AND ci.deleted_at IS NULL
            AND ci.status <> ALL(${UNALLOCATABLE_INVOICE_STATUSES}::TEXT[])
            AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
          ORDER BY ci.invoice_date ASC, ci.due_date ASC NULLS LAST, ci.id ASC
          FOR UPDATE OF ci`
      : await sql`
          SELECT ci.id, ci.invoice_number,
                 (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
          FROM customer_invoices ci
          WHERE ci.company_id = ${companyId}::UUID
            AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
            AND ci.deleted_at IS NULL
            AND ci.status <> ALL(${UNALLOCATABLE_INVOICE_STATUSES}::TEXT[])
            AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
          ORDER BY ci.invoice_date ASC, ci.due_date ASC NULLS LAST, ci.id ASC`)
    : (opts.forUpdate
      ? await sql`
          SELECT ci.id, ci.invoice_number,
                 (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
          FROM customer_invoices ci
          WHERE ci.company_id = ${companyId}::UUID
            AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
            AND ci.deleted_at IS NULL
            AND ci.status <> ALL(${UNALLOCATABLE_INVOICE_STATUSES}::TEXT[])
            AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
          ORDER BY ci.invoice_date DESC, ci.due_date DESC NULLS FIRST, ci.id DESC
          FOR UPDATE OF ci`
      : await sql`
          SELECT ci.id, ci.invoice_number,
                 (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
          FROM customer_invoices ci
          WHERE ci.company_id = ${companyId}::UUID
            AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
            AND ci.deleted_at IS NULL
            AND ci.status <> ALL(${UNALLOCATABLE_INVOICE_STATUSES}::TEXT[])
            AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
          ORDER BY ci.invoice_date DESC, ci.due_date DESC NULLS FIRST, ci.id DESC`)) as DbRow[];

  return rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    outstanding: Number(r.outstanding),
  }));
}
