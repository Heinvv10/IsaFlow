/**
 * Supplier Payment Workflow Service
 * Process and void payment operations — split from supplierPaymentService.ts
 * (approve: supplierPaymentApproval.ts).
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { defaultHumanMeta } from '../gl/journalEntryMeta';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import { getSupplierPaymentById } from './supplierPaymentService';
import { mapPaymentRow } from './supplierPaymentRow';
import { assertPaymentStillProcessable, voidIfUnprocessed } from './supplierPaymentGates';
import { assertPaymentApprovalCleared } from './supplierPaymentApproval';
import { SupplierPaymentNotFoundError } from './supplierPaymentNotFound';
import {
  assertSameJournal, lockJournalAndUnmatch, lockPaymentBankLeg, voidViaBankAllocation,
} from './paymentJournalReversal';
import type { SupplierPayment } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { underFlowLockBudget } from '../core/rowLockBudget';
import { assertMayReverseMatchedLeg } from '../bank/bankReversalGate';
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

// Approve (and the gate both steps consult) lives beside it, under the file-size cap.
export { approveSupplierPayment } from './supplierPaymentApproval';
export { SupplierPaymentNotFoundError };

/**
 * Raised when the payment is not 'approved' under its row lock — because it
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
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  try {
    // (2) THE PAYMENT FIRST — same canonical order as the void below. Without
    // it this path took `supplier_invoices` (the allocation loop) before
    // `supplier_payments` (the status flip), the inverse of
    // `planSupplierPaymentApplication`, which locks the payment and THEN the
    // bills through `fetchBillCandidates`. Both reach the same payment and the
    // same bill, from `supplier-payments-action` and `supplier-allocations`.
    if (!(await lockSupplierPaymentForUpdate(companyId, id))) {
      throw new SupplierPaymentNotFoundError(id);
    }
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new SupplierPaymentNotFoundError(id);
    // Decided under the payment lock, so a double-click's loser is told the
    // payment is processed (409) rather than that its bills are now paid.
    if (payment.status !== 'approved') throw new SupplierPaymentNotProcessableError(payment.status);
    // Not a batch member, and every bill still payable (K-063/K-066) — before the posting.
    await assertPaymentStillProcessable(companyId, payment);
    // R-035 PR5: the money moves here, so the approval is re-checked under the
    // lock — before the posting, so the route's 409 commits nothing.
    await assertPaymentApprovalCleared(companyId, payment);

    // No separate CLAIM before the posting: the payment row lock above already serialises a double-click (the loser
    // waits on it, then reads 'processed' and is refused 409 before posting anything, K-107), so the row is written
    // ONCE, at the end. A second write of a row this transaction already wrote re-runs its foreign-key checks, and
    // the supplier FK's FOR KEY SHARE on `suppliers`, taken after the payment, crossed updateSupplier (supplier FOR
    // UPDATE, then the supplier's payments in recordBankDetailsSetter): 40P01. Written once, this path locks no
    // supplier row at all (ap/.claude.md, 2026-10-24).
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

    // The one write of the payment row: status, timestamp and journal link together.
    const updatedRows = (await sql`
      UPDATE supplier_payments SET status = 'processed', processed_at = NOW(), gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'approved'
      RETURNING *
    `) as Row[];
    // Unreachable under the lock. A plain Error (500), so the posting above rolls back with the request; never the
    // typed 409, which is raised only before the journal exists.
    if (!updatedRows[0]) throw new Error('Cannot process payment: its status changed concurrently');
    const updated = updatedRows[0];

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
  // SAVEPOINT: callers map errors to 400 and withAuth commits on <5xx (a failure after the reversal's draft INSERTs
  // must roll them back). Every lock under ONE budget, plain UPDATEs included (D8 round 10).
  return withSavepoint('void_supplier_payment', () => underFlowLockBudget(`Payment ${id}`, () =>
    voidSupplierPaymentInner(companyId, id, userId)));
}

async function voidSupplierPaymentInner(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  try {
    // (1) THE BANK LINE matched to its journal, from an unlocked peek — the
    // canonical order starts at the bank row (as `voidPaymentDocument` does).
    // This also runs the pre-write journal refusals: a closed period or a
    // reconciled line is a 400 here, not a 500 inside `reverseJournalEntry`.
    const { journalId, leg } = await lockPaymentBankLeg(companyId, id);
    // (2) THEN THE PAYMENT. This used to open with the unlocked
    // `getSupplierPaymentById` and take `gl_journal_entries` before
    // `supplier_invoices` before `supplier_payments` — the exact inverse of the
    // canonical order in `bank/.claude.md`, and a reachable cycle against
    // `voidPaymentDocument` (which takes payment → invoices → GL) on the very
    // same supplier payment. Two agents voiding one payment from its two
    // entrances held a row each and Postgres killed one with 40P01.
    if (!(await lockSupplierPaymentForUpdate(companyId, id))) {
      throw new SupplierPaymentNotFoundError(id);
    }
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new SupplierPaymentNotFoundError(id);
    // Refuses reconciled, batch members and other statuses; a draft/approved
    // payment is voided as a status change. Only a processed one continues.
    if (await voidIfUnprocessed(companyId, payment, userId)) return { ...payment, status: 'cancelled' };
    assertSameJournal(journalId, payment.glJournalEntryId);
    // A bank ALLOCATION posted this journal: undo it the MCP void's way — bills,
    // payment, contra and bank line in one call (`voidViaBankAllocation`).
    if (leg // an OUT chain too: the bank path frees the line and reverses nothing (D8)
      && await voidViaBankAllocation(companyId, leg, userId, `Payment ${payment.paymentNumber}`, journalId)) {
      return (await getSupplierPaymentById(companyId, id)) ?? { ...payment, status: 'cancelled' };
    }

    // Step 2 (round 1's rule): a statement line MATCHED to this journal makes it a bank allocation — judged as the bank
    // line's own reverse is (the maker, an agent, "login as" refused under enforcement), before the first write below.
    const auditLeg = journalId && leg ? await assertMayReverseMatchedLeg(companyId, journalId, leg.bankLineIds, userId) : null;

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

    // (4) Free the bank line, then reverse the payment journal — its chain head
    // (`leg.reverseId`, D8). The line is freed even when the chain is already out.
    if (journalId && leg) {
      await lockJournalAndUnmatch(companyId, journalId, leg, `Payment ${payment.paymentNumber}`);
      if (!leg.alreadyReversed) await reverseJournalEntry(companyId, leg.reverseId, userId);
    }
    await auditLeg?.();

    // Guarded flip: the status re-assertion is now redundant against a
    // concurrent void (the row has been locked since the top of this function)
    // and is KEPT as the row-returning write and as a guard against a future
    // caller that reaches here without the lock.
    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'cancelled'
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status IN ('processed', 'reconciled')
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
