/**
 * The row-level reads and writes behind a credit-note application.
 *
 * Split from creditNoteFifo.ts for the 300-line cap in CLAUDE.md. The seam is
 * the altitude: creditNoteFifo decides WHICH documents a note settles and for
 * how much, and everything here is what one of those decisions does to one row.
 *
 * ── THE LOCK IS THE POINT ───────────────────────────────────────────────────
 *
 * `lockInvoicesForUpdate` is not a convenience reader. Planning an application
 * from an UNLOCKED balance is a check-then-act pair across two requests: two
 * credit notes for one customer, approved concurrently against a single invoice
 * owing 1,000, both read 1,000, and one applies 500 while the other applies 800
 * — `amount_paid` lands at 1,300 on a 1,000 invoice. The receipt side already
 * fixed this shape (`ar/receiptAllocationLines` takes `FOR UPDATE OF ci`), and
 * so does `applyCreditNoteToInvoice`; the FIFO walk must too.
 *
 * Three rules it has to keep at once:
 *
 *   · **Lock before planning.** The figures the plan consumes are the LOCKED
 *     ones, never the ones the candidate query returned.
 *   · **ORDER BY id.** One statement takes every row the note will touch, in id
 *     order, so two overlapping approvals acquire the shared rows in the same
 *     direction and cannot deadlock (40P01 surfaces as GENERIC_FAILURE and does
 *     not read as retryable to an agent).
 *   · **Bounded.** Unbounded, the wait lasts as long as the holder lives while
 *     this request is already holding the credit note — one stuck request
 *     becomes two. The two helpers carry the 5s `lock_timeout` and the typed
 *     `…LockTimeoutError` the routes turn into "retry in a moment" (K-011).
 *
 * `deleted_at IS NULL` is here rather than inherited: a soft-deleted document
 * has had its journal reversed, so crediting it moves a balance the ledger no
 * longer carries.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { withCustomerInvoiceLock } from '../ar/customerInvoiceLock';
import { withSupplierInvoiceLock } from '../ap/supplierInvoiceLock';
import { round2 } from './autoAllocateStrategy';
import type { CreditNoteApplicationLine, CreditNoteSide } from './creditNoteFifo';

/**
 * Statuses that cannot take a credit, per side.
 *
 * Deliberately the same sets `ar/customerAutoAllocate` and
 * `ap/supplierAutoAllocate` refuse on, restated here because neither exports
 * them and both are owned by another branch. If they change, change these with
 * them — credit and cash disagreeing about which document is eligible is the
 * drift this comment exists to catch.
 */
export const UNAPPLICABLE_STATUSES: Record<CreditNoteSide, readonly string[]> = {
  customer: ['draft', 'pending_approval', 'cancelled', 'paid', 'written_off'],
  supplier: ['draft', 'cancelled', 'paid', 'written_off'],
};

export interface LockedDocument {
  outstanding: number;
  status: string;
}

/** Run `fn` under this side's BOUNDED invoice row lock — see the header. */
export function underInvoiceLock<T>(
  operation: string,
  side: CreditNoteSide,
  subject: string,
  fn: () => Promise<T>,
): Promise<T> {
  return side === 'customer'
    ? withCustomerInvoiceLock(operation, subject, fn)
    : withSupplierInvoiceLock(operation, subject, fn);
}

/**
 * Take the row lock on every document a note is about to touch, and return
 * their balances AS LOCKED.
 *
 * An id that comes back absent is one that does not exist in this company or
 * has been soft-deleted; the caller decides whether that is a refusal (a named
 * link) or a skip (a candidate the walk found).
 *
 * Status is returned rather than filtered: a note against a settled invoice is
 * an ordinary event that applies nothing, and filtering the row out here would
 * make it indistinguishable from a deleted one.
 */
export async function lockInvoicesForUpdate(
  operation: string,
  companyId: string,
  side: CreditNoteSide,
  invoiceIds: readonly string[],
): Promise<Map<string, LockedDocument>> {
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return new Map();

  const rows = await underInvoiceLock(operation, side, `${ids.length} document(s)`, async () =>
    (side === 'customer'
      ? await sql`
          SELECT id, status,
                 (total_amount - COALESCE(amount_paid, 0)) AS outstanding
          FROM customer_invoices
          WHERE id = ANY(${ids}::UUID[]) AND company_id = ${companyId}::UUID
            AND deleted_at IS NULL
          ORDER BY id
          FOR UPDATE`
      : await sql`
          SELECT id, status,
                 (total_amount - COALESCE(amount_paid, 0)) AS outstanding
          FROM supplier_invoices
          WHERE id = ANY(${ids}::UUID[]) AND company_id = ${companyId}::UUID
            AND deleted_at IS NULL
          ORDER BY id
          FOR UPDATE`) as DbRow[]);

  return new Map(rows.map((r) => [String(r.id), {
    outstanding: Math.max(0, round2(Number(r.outstanding))),
    status: String(r.status ?? ''),
  }]));
}

/**
 * Write ONE application: the allocation row, the document's `amount_paid`, and
 * the status recompute — in that order, so a failed money write leaves no row
 * claiming the money moved.
 *
 * No lock is taken here: `lockInvoicesForUpdate` already holds this row for the
 * rest of the transaction, which is what makes the amount written safe. Taking
 * one again would be a second `SET LOCAL lock_timeout` for no gain.
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
  const applied = (side === 'customer'
    ? await sql`
        UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
        RETURNING id`
    : await sql`
        UPDATE supplier_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
        RETURNING id`) as DbRow[];
  // A row count of zero means the document vanished between the read and the
  // write. Refusing beats an allocation row pointing at nothing.
  if (applied.length !== 1) {
    throw new Error(
      `Credit note ${creditNoteId}: applying ${line.amount} to invoice ${line.invoiceId} wrote no row.`,
    );
  }
  await recomputeInvoiceStatus(companyId, side, line.invoiceId);
}

/**
 * Take back ONE application. The row lock is already held by
 * `lockInvoicesForUpdate`, as on the way in.
 *
 * `amount_paid >= X` rather than GREATEST(0, ...): flooring at zero silently
 * absorbs exactly the corruption worth hearing about.
 */
export async function undoApplication(
  companyId: string,
  creditNoteId: string,
  side: CreditNoteSide,
  line: CreditNoteApplicationLine,
): Promise<void> {
  const done = (side === 'customer'
    ? await sql`
        UPDATE customer_invoices SET amount_paid = amount_paid - ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
          AND amount_paid >= ${line.amount}
        RETURNING id`
    : await sql`
        UPDATE supplier_invoices SET amount_paid = amount_paid - ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
          AND amount_paid >= ${line.amount}
        RETURNING id`) as DbRow[];
  if (done.length === 0) {
    throw new Error(
      `Cannot cancel credit note ${creditNoteId}: invoice ${line.invoiceId} has less applied than the ${line.amount} this note credited.`,
    );
  }
  await recomputeInvoiceStatus(companyId, side, line.invoiceId);
}
