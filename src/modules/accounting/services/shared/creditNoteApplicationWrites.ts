/**
 * The row-level writes behind a credit-note application.
 *
 * Split from creditNoteFifo.ts for the 300-line cap in CLAUDE.md. The seam is
 * the altitude: creditNoteFifo decides WHICH documents a note settles and for
 * how much, and everything here is what one of those decisions does to one row.
 *
 * Read creditNoteFifo's header first — it carries the reasoning these functions
 * serve.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { withCustomerInvoiceLock } from '../ar/customerInvoiceLock';
import { withSupplierInvoiceLock } from '../ap/supplierInvoiceLock';
import { round2 } from './autoAllocateStrategy';
import type { CreditNoteApplicationLine, CreditNoteSide } from './creditNoteFifo';

export async function readOutstanding(
  companyId: string,
  side: CreditNoteSide,
  invoiceId: string,
): Promise<number | null> {
  const rows = (side === 'customer'
    ? await sql`
        SELECT total_amount, amount_paid FROM customer_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`
    : await sql`
        SELECT total_amount, amount_paid FROM supplier_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  return Math.max(0, round2(Number(row.total_amount) - Number(row.amount_paid ?? 0)));
}

/**
 * Run `fn` under this side's BOUNDED invoice row lock.
 *
 * Every `amount_paid` write below takes the invoice's row lock through the
 * UPDATE statement itself, and unbounded that waits on the row for as long as
 * the holder lives — while this request is already holding the credit note, so
 * one stuck request becomes two. The two helpers carry the 5s `lock_timeout`
 * and the typed `…LockTimeoutError` that the routes turn into "retry in a
 * moment" (K-011).
 *
 * It matters MORE since the FIFO walk than it did before it: an approval used
 * to touch the one document the note named and now touches every document its
 * remainder settles, so the number of rows it can hang on grew with it.
 */
export function underInvoiceLock<T>(
  operation: string,
  side: CreditNoteSide,
  invoiceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return side === 'customer'
    ? withCustomerInvoiceLock(operation, `Invoice ${invoiceId}`, fn)
    : withSupplierInvoiceLock(operation, invoiceId, fn);
}

/**
 * Write ONE application: the allocation row, the document's `amount_paid`, and
 * the status recompute — in that order, so a failed money write leaves no row
 * claiming the money moved.
 *
 * `recomputeInvoiceStatus` owns the status and `paid_at`; nothing here writes
 * either by hand.
 */
export async function writeApplication(
  companyId: string,
  creditNoteId: string,
  side: CreditNoteSide,
  line: CreditNoteApplicationLine,
): Promise<void> {
  await sql`
    INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
    VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${line.invoiceId}::UUID, ${line.amount})
  `;
  const applied = await underInvoiceLock('applyCreditNote', side, line.invoiceId, async () =>
    (side === 'customer'
      ? await sql`
          UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
          WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
          RETURNING id`
      : await sql`
          UPDATE supplier_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
          WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
          RETURNING id`) as DbRow[]);
  // A row count of zero means the document vanished between the read and the
  // write. Refusing beats an allocation row pointing at nothing.
  if (applied.length !== 1) {
    throw new Error(
      `Credit note ${creditNoteId}: applying ${line.amount} to invoice ${line.invoiceId} wrote no row.`,
    );
  }
  await recomputeInvoiceStatus(companyId, side, line.invoiceId);
}

