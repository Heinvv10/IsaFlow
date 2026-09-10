/**
 * Supplier Payment Workflow Service
 * Approve and process payment operations — split from supplierPaymentService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { defaultHumanMeta } from '../gl/journalEntryMeta';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import { getSupplierPaymentById } from './supplierPaymentService';
import type { SupplierPayment } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
type Row = DbRow;

/**
 * Allocation rows in ASCENDING invoice id — the order `fetchBillCandidates`
 * already takes its `FOR UPDATE OF si` in. Two payments touching the same two
 * bills in opposite orders hold one row each and deadlock (40P01), and the
 * order a payment's allocations come back in is the order they were captured.
 */
function byInvoiceId<T extends { invoiceId: string }>(allocs: readonly T[]): T[] {
  return [...allocs].sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));
}

export async function approveSupplierPayment(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new SupplierPaymentNotFoundError(id);
    if (payment.status !== 'draft') throw new Error(`Cannot approve payment with status: ${payment.status}`);

    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];

    return mapPaymentRow(rows[0]!);
  } catch (err) {
    log.error('Failed to approve supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * Raised when the payment id does not resolve inside this company. Raised by
 * approve, process and void BEFORE any write, so a route may answer it 404.
 *
 * Typed rather than matched on the message: the route classified it with
 * `/not found$/`, which also matched 'Bank account not found' — thrown AFTER
 * `processSupplierPayment` has claimed the payment. That answered 404, and
 * `withAuth` COMMITs below 500, so the payment stayed 'processed' with no
 * journal and no path back: every retry hit the claim it had already taken.
 */
export class SupplierPaymentNotFoundError extends Error {
  readonly code = 'SUPPLIER_PAYMENT_NOT_FOUND';
  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = 'SupplierPaymentNotFoundError';
  }
}

/**
 * Raised when the payment is not 'approved' when the claim runs — because it
 * never was, or because a concurrent request has already processed it. Raised
 * BEFORE the journal is created, so a route may answer it with a 4xx without
 * `withAuth` committing a half-processed payment.
 */
export class SupplierPaymentNotProcessableError extends Error {
  readonly code = 'SUPPLIER_PAYMENT_NOT_PROCESSABLE';
  constructor(readonly paymentStatus: string) {
    super(`Payment is ${paymentStatus}, not approved — it cannot be processed.`);
    this.name = 'SupplierPaymentNotProcessableError';
  }
}

/**
 * @param opts.postingAgent Stamp for the DR Accounts Payable / CR Bank journal
 *   this posts. Optional and last-positional so every existing caller keeps its
 *   `human:<userId>` attribution; only non-human callers (the MCP
 *   settle_by_contra tool) pass it. Same reasoning as
 *   approveSupplierInvoice / postSupplierInvoiceToGL.
 */
export async function processSupplierPayment(
  companyId: string,
  id: string,
  userId: string,
  opts?: { postingAgent?: string },
): Promise<SupplierPayment> {
  try {
    // (2) THE PAYMENT FIRST — same canonical order as the void below. Without
    // it this path took `supplier_invoices` (the allocation loop) before
    // `supplier_payments` (the status flip), the inverse of
    // `planSupplierPaymentApplication`, which locks the payment and THEN the
    // bills through `fetchBillCandidates`. Both reach the same payment and the
    // same bill, from `supplier-payments-action` and `supplier-allocations`.
    if (!(await lockSupplierPaymentForUpdate(companyId, id))) {
      throw new Error(`Payment ${id} not found`);
    }
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new SupplierPaymentNotFoundError(id);

    // CLAIM the payment before anything is posted — the singular twin of
    // batchPaymentService.processBatch, which carried the identical defect.
    // What this replaced read `payment.status !== 'approved'` and then created
    // and POSTED DR AP / CR Bank for the full amount and incremented
    // `amount_paid` on every allocated bill, with the payment's own row
    // rewritten unconditionally: two concurrent "process" clicks credited the
    // bank twice and overstated the supplier ledger, and only one journal id
    // survived on the payment to show for it. The status-predicated UPDATE is
    // the guard — the loser matches zero rows and stops here, before the first
    // posting — and it also moves the first blocking point off the per-company
    // entry_number trigger, where two interleaved callers used to park on each
    // other with no lock_timeout at all.
    const claimed = await claimUnderLockTimeout('supplier payment', async () => (await sql`
      UPDATE supplier_payments
      SET status = 'processed', processed_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'approved'
      RETURNING id
    `) as Row[]);
    if (claimed.length === 0) {
      // Re-read rather than trusting the row read before the UPDATE: the loser
      // of a double-click needs the status the winner left behind.
      const now = await getSupplierPaymentById(companyId, id);
      throw new SupplierPaymentNotProcessableError(now?.status ?? 'missing');
    }

    const apAccount = await getSystemAccount('payable', companyId);
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT * FROM gl_accounts WHERE id = ${payment.bankAccountId}::UUID AND company_id = ${companyId}::UUID`) as Row[])[0]
      : await getSystemAccount('bank', companyId);

    if (!bankAccount) throw new Error('Bank account not found');

    const lines: JournalLineInput[] = [
      {
        glAccountId: apAccount.id,
        debit: payment.totalAmount,
        credit: 0,
        description: `Payment ${payment.paymentNumber} to supplier`,
      },
      {
        glAccountId: String(bankAccount.id),
        debit: 0,
        credit: payment.totalAmount,
        description: `Payment ${payment.paymentNumber} to supplier`,
      },
    ];

    const journalEntry = await createJournalEntry(companyId, {
      entryDate: payment.paymentDate,
      description: `Supplier payment ${payment.paymentNumber}`,
      source: 'auto_supplier_payment',
      lines,
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : defaultHumanMeta(userId));

    await postJournalEntry(companyId, journalEntry.id, userId);

    // Run on the ALS-bound connection so the outer request-scoped tx provides
    // atomicity — withTransaction would deadlock against rows already locked
    // by this same request (e.g. the JE we just inserted/posted above).
    for (const alloc of byInvoiceId(payment.allocations)) {
      const newPaid = alloc.amountAllocated;
      await sql`
        UPDATE supplier_invoices
        SET amount_paid = amount_paid + ${newPaid},
            status = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN 'paid'
              WHEN (amount_paid + ${newPaid}) > 0 THEN 'partially_paid'
              ELSE status
            END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }

    // Only the journal link is left to write — the status and timestamp were
    // set by the claim above.
    const updatedRows = (await sql`
      UPDATE supplier_payments
      SET gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];
    const updated = updatedRows[0] as Row;

    log.info('Processed supplier payment', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to process supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * Void a PROCESSED supplier payment (P2.1 / audit W4): reverse its GL journal
 * (metadata semantics — contra entry, reversed_at on the original), un-apply
 * its allocations, and set the payment to 'cancelled'. Reconciled payments
 * are anchored to a bank reconciliation and must be un-reconciled first.
 */
export async function voidSupplierPayment(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  // SAVEPOINT: callers map errors to 400 and withAuth commits on <5xx — a
  // failure after the reversal's draft INSERTs must roll them back.
  return withSavepoint('void_supplier_payment', () =>
    voidSupplierPaymentInner(companyId, id, userId),
  );
}

async function voidSupplierPaymentInner(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  try {
    // (2) THE PAYMENT FIRST. This used to open with the unlocked
    // `getSupplierPaymentById` and take `gl_journal_entries` before
    // `supplier_invoices` before `supplier_payments` — the exact inverse of the
    // canonical order in `bank/.claude.md`, and a reachable cycle against
    // `voidPaymentDocument` (which takes payment → invoices → GL) on the very
    // same supplier payment. Two agents voiding one payment from its two
    // entrances held a row each and Postgres killed one with 40P01.
    if (!(await lockSupplierPaymentForUpdate(companyId, id))) {
      throw new Error(`Payment ${id} not found`);
    }
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new SupplierPaymentNotFoundError(id);
    if (payment.status === 'reconciled') {
      throw new Error('Cannot void a reconciled payment — remove it from the bank reconciliation first');
    }
    if (payment.status !== 'processed') {
      throw new Error(`Only processed payments can be voided (status: ${payment.status})`);
    }

    // (3) Un-apply allocations: roll amount_paid back and recompute status.
    // A voided payment returns the invoice to its pre-payment state
    // ('approved' when nothing else is paid, 'partially_paid' otherwise).
    // BY INVOICE ID, for the reason `fetchBillCandidates` orders: two voids
    // touching the same two bills in opposite orders deadlock on each other.
    // This also runs BEFORE the journal reversal now, which is the ordering
    // `bankAllocationUnwind.ts` argues for on its own merits — reversing first
    // returns the credit to AP control while the bill still reads as settled.
    for (const alloc of byInvoiceId(payment.allocations)) {
      // Mirrors processSupplierPayment's CASE: compare the REMAINING paid
      // amount against total_amount so an invoice still fully covered by
      // OTHER payments keeps status 'paid' (PR #203 review MEDIUM).
      await sql`
        UPDATE supplier_invoices
        SET amount_paid = GREATEST(amount_paid - ${alloc.amountAllocated}, 0),
            status = CASE
              WHEN (total_amount - GREATEST(amount_paid - ${alloc.amountAllocated}, 0)) <= 0.01 THEN 'paid'
              WHEN GREATEST(amount_paid - ${alloc.amountAllocated}, 0) > 0.01 THEN 'partially_paid'
              ELSE 'approved'
            END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }

    // (4) Reverse the payment journal LAST — the pre-existing entry is the
    // most-contended row of the four and the canonical order puts it last.
    // Skip if already reversed: `reversed_at` is the marker; the original keeps
    // status='posted' under metadata semantics.
    if (payment.glJournalEntryId) {
      const jeRows = (await sql`
        SELECT status, reversed_at FROM gl_journal_entries
        WHERE id = ${payment.glJournalEntryId}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `) as Row[];
      if (
        jeRows.length > 0 &&
        String(jeRows[0]!.status) === 'posted' &&
        jeRows[0]!.reversed_at == null
      ) {
        await reverseJournalEntry(companyId, payment.glJournalEntryId, userId);
      }
    }

    // Guarded flip: the status re-assertion is now redundant against a
    // concurrent void (the row has been locked since the top of this function)
    // and is KEPT as the row-returning write and as a guard against a future
    // caller that reaches here without the lock.
    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'cancelled'
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status = 'processed'
      RETURNING *
    `) as Row[];
    if (rows.length !== 1) {
      throw new Error('Payment state changed concurrently — void aborted');
    }

    log.info('Voided supplier payment', { id, journalEntryId: payment.glJournalEntryId }, 'accounting');
    return mapPaymentRow(rows[0]!);
  } catch (err) {
    log.error('Failed to void supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

function mapPaymentRow(row: Row): SupplierPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    supplierId: String(row.supplier_id),
    paymentDate: fmtDate(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as SupplierPayment['paymentMethod'],
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    reference: row.reference ? String(row.reference) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as SupplierPayment['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    processedAt: row.processed_at ? String(row.processed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
  };
}
