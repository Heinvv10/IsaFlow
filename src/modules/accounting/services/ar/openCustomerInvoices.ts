/**
 * A customer's open invoices, in the order cash will consume them — the AR twin
 * of `ap/openSupplierBills`, and identical to it in every rule that matters.
 *
 * `COALESCE(ci.client_id, ci.customer_id)` because both columns exist and
 * either can carry the customer; matching on one alone silently misses half the
 * ledger.
 *
 * See the AP twin's header for the three properties this shares with it: the
 * eligible set is POSITIVE and is the same constant `recomputeInvoiceStatus` is
 * gated on, the row lock is taken in `id` order with the FIFO ordering applied
 * in memory (locking in date order deadlocks against every other path here),
 * and the lock itself is the caller's choice because the bulk dry run reads
 * these rows without writing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EPS } from '../shared/autoAllocateStrategy';
import type { SimulationDocument } from '../shared/autoApplySimulation';
import { FIFO_ELIGIBLE_STATUSES } from './invoiceStatusRecompute';
import { requireRequestTransaction } from '../core/requestTransaction';
import { isLockContention } from '../core/lockContention';
import { ReceiptRefusal } from './receiptRefusal';
import { orderOpenDocuments, type OpenDocumentRow } from '../shared/openDocumentOrder';
import type { OpenDocumentFetchOptions } from '../ap/openSupplierBills';

function toRows(rows: DbRow[]): OpenDocumentRow[] {
  return rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    outstanding: Number(r.outstanding),
    invoiceDate: r.invoice_date instanceof Date
      ? r.invoice_date.toISOString().slice(0, 10)
      : String(r.invoice_date ?? ''),
    dueDate: r.due_date === null || r.due_date === undefined
      ? null
      : (r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : String(r.due_date)),
  }));
}

export async function fetchOpenCustomerInvoices(
  companyId: string,
  customerId: string,
  oldestFirst: boolean,
  opts: OpenDocumentFetchOptions,
): Promise<SimulationDocument[]> {
  // `FOR UPDATE OF ci` and never a bare `FOR UPDATE`: the lock belongs to the
  // invoice rows this receipt is about to consume.
  const read = async (): Promise<DbRow[]> => (opts.forUpdate
    ? await sql`
        SELECT ci.id, ci.invoice_number, ci.invoice_date, ci.due_date,
               (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
        FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
          AND ci.deleted_at IS NULL
          AND ci.status = ANY(${[...FIFO_ELIGIBLE_STATUSES]}::TEXT[])
          AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
        ORDER BY ci.id
        FOR UPDATE OF ci`
    : await sql`
        SELECT ci.id, ci.invoice_number, ci.invoice_date, ci.due_date,
               (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
        FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
          AND ci.deleted_at IS NULL
          AND ci.status = ANY(${[...FIFO_ELIGIBLE_STATUSES]}::TEXT[])
          AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
        ORDER BY ci.id`) as DbRow[];

  if (!opts.forUpdate) return orderOpenDocuments(toRows(await read()), oldestFirst);

  const client = requireRequestTransaction('fetchOpenCustomerInvoices');
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = await read();
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return orderOpenDocuments(toRows(rows), oldestFirst);
  } catch (err) {
    // Not in a `finally` — see the AP twin.
    if (isLockContention(err)) {
      throw new ReceiptRefusal(
        'Another request is applying cash to one of these invoices — retry in a moment.',
        { retryable: true },
      );
    }
    throw err;
  }
}
