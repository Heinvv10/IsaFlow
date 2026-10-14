/**
 * Customer Payment Allocation Service
 * Customer payment confirmation/cancellation logic (invoice GL posting is in
 * customerInvoiceGlPosting.ts).
 * Extracted from customerPaymentService.ts for file-size compliance.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { defaultHumanMeta } from '../gl/journalEntryMeta';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { lockCustomerPaymentForUpdate } from '../core/paymentLock';
import { assertSameJournal, lockJournalAndUnmatch, voidViaBankAllocation } from '../ap/paymentJournalReversal';
import { lockReceiptBankLeg } from './receiptBankLeg';
import { getCustomerPaymentById } from './customerPaymentService';
import type { CustomerPayment } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';
import { underFlowLockBudget } from '../core/rowLockBudget';

type Row = DbRow;

/**
 * Allocation rows in ASCENDING invoice id — the order `fetchInvoiceCandidates`
 * already takes its `FOR UPDATE OF ci` in. Two receipts touching the same two
 * invoices in opposite orders hold one row each and deadlock (40P01).
 */
function byInvoiceId<T extends { invoiceId: string }>(allocs: readonly T[]): T[] {
  return [...allocs].sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));
}

/**
 * @param opts.postingAgent Stamp for the DR Bank / CR AR journal this posts.
 *   Optional and last-positional so every existing caller keeps its current
 *   `human:<userId>` attribution; only callers that are NOT a human clicking
 *   Confirm (the MCP settle_by_contra tool) pass it. Without it
 *   `createJournalEntry` falls back to `defaultHumanMeta(userId)`, which
 *   affirmatively claims the token owner made the entry by hand and hides it
 *   from `list_agent_postings`. Mirrors postCustomerInvoiceToGL.
 */
export async function confirmCustomerPayment(
  companyId: string,
  id: string,
  userId: string,
  opts?: { postingAgent?: string },
): Promise<CustomerPayment> {
  // SAVEPOINT: the route answers 400 for everything and `withAuth` COMMITs a
  // 4xx, so a throw after the invoice loop would commit invoices reading as
  // paid against a payment still 'draft'.
  return withSavepoint('confirm_customer_payment', () =>
    confirmCustomerPaymentInner(companyId, id, userId, opts),
  );
}

async function confirmCustomerPaymentInner(
  companyId: string,
  id: string,
  userId: string,
  opts?: { postingAgent?: string },
): Promise<CustomerPayment> {
  try {
    // (2) THE PAYMENT FIRST — the inverse of `planReceiptApplication`, which
    // locks the receipt and THEN the invoices through `fetchInvoiceCandidates`;
    // both reach the same payment and the same invoice. The journal this posts
    // below is CREATED here, so no other transaction can contend for it and it
    // does not belong to the ordering.
    if (!(await lockCustomerPaymentForUpdate(companyId, id))) {
      throw new Error(`Payment ${id} not found`);
    }
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'draft') throw new Error(`Cannot confirm payment with status: ${payment.status}`);

    // Auto-post GL: DR Bank, CR Accounts Receivable
    const arAccount = await getSystemAccount('receivable', companyId);
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT id FROM gl_accounts WHERE id = ${payment.bankAccountId} AND company_id = ${companyId}`) as Row[])[0]
      : await getSystemAccount('bank', companyId);
    if (!bankAccount) throw new Error('Bank account not found');

    const lines: JournalLineInput[] = [
      { glAccountId: String(bankAccount.id), debit: payment.totalAmount, credit: 0,
        description: `Customer payment ${payment.paymentNumber}` },
      { glAccountId: arAccount.id, debit: 0, credit: payment.totalAmount,
        description: `Customer payment ${payment.paymentNumber}` },
    ];

    const je = await createJournalEntry(companyId, {
      entryDate: payment.paymentDate,
      description: `Customer payment ${payment.paymentNumber}`,
      source: 'auto_payment',
      lines,
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : defaultHumanMeta(userId));
    await postJournalEntry(companyId, je.id, userId);

    // Update invoice balances and mark payment confirmed — runs on the ALS-bound
    // connection so the outer withAuth transaction provides atomicity, and BY
    // INVOICE ID so two confirms sharing two invoices cannot deadlock.
    for (const alloc of byInvoiceId(payment.allocations)) {
      const newPaid = alloc.amountAllocated;
      await sql`
        UPDATE customer_invoices
        SET amount_paid = amount_paid + ${newPaid},
            status = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN 'paid'
              WHEN (amount_paid + ${newPaid}) > 0 THEN 'partially_paid'
              ELSE status
            END,
            paid_at = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN NOW()
              ELSE paid_at
            END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }

    const updatedRows = (await sql`
      UPDATE customer_payments
      SET status = 'confirmed', confirmed_by = ${userId}::UUID, confirmed_at = NOW(),
          gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Row[];
    const updated = updatedRows[0] as Row;

    log.info('Confirmed customer payment', { id, journalEntryId: je.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to confirm customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelCustomerPayment(
  companyId: string,
  id: string,
  userId: string,
  reason?: string,
): Promise<CustomerPayment> {
  // SAVEPOINT for the same reason `voidSupplierPayment` has one, and it is what
  // makes the reorder below safe: the route catches EVERYTHING and answers 400,
  // which `withAuth` COMMITs — so a throw between the invoice roll-back and the
  // payment flip would otherwise leave the invoices un-applied against a
  // payment still reading 'confirmed'.
  return withSavepoint('cancel_customer_payment', () => underFlowLockBudget(`Receipt ${id}`, () => // one lock budget
    cancelCustomerPaymentInner(companyId, id, userId, reason)));
}

async function cancelCustomerPaymentInner(
  companyId: string,
  id: string,
  userId: string,
  reason?: string,
): Promise<CustomerPayment> {
  try {
    // (1) THE BANK LINE, then (2) THE PAYMENT — the canonical order in `bank/.claude.md`, as `voidSupplierPayment`
    // takes it; the line is freed below (D8 round 6: it stayed allocated/matched to a journal the cancel took out).
    const { journalId, leg } = await lockReceiptBankLeg(companyId, id);
    if (!(await lockCustomerPaymentForUpdate(companyId, id))) throw new Error(`Payment ${id} not found`);
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'confirmed') throw new Error(`Cannot cancel payment with status: ${payment.status}`);
    assertSameJournal(journalId, payment.glJournalEntryId);
    const label = `Receipt ${payment.paymentNumber}`;
    // A bank ALLOCATION posted the journal: the bank path unwinds the receipt, posts the contra and frees the line.
    const delegated = !!leg && !!journalId && await voidViaBankAllocation(companyId, leg, userId, label, journalId);
    // Step 2: a statement line MATCHED to this journal (a refund out is gated; a receipt is money in) — before any write.
    const auditLeg = !delegated && journalId && leg ? await assertMayReverseMatchedLeg(companyId, journalId, leg.bankLineIds, userId) : null;

    // (3) Reverse invoice balances — runs on the ALS-bound connection so the
    // outer withAuth transaction provides atomicity, and BY INVOICE ID so two
    // cancels touching the same two invoices cannot deadlock on each other.
    for (const alloc of delegated ? [] : byInvoiceId(payment.allocations)) {
      await sql`
        UPDATE customer_invoices
        SET amount_paid = GREATEST(0, amount_paid - ${alloc.amountAllocated}),
            status = CASE
              WHEN GREATEST(0, amount_paid - ${alloc.amountAllocated}) <= 0.01 THEN 'approved'
              WHEN GREATEST(0, amount_paid - ${alloc.amountAllocated}) < total_amount THEN 'partially_paid'
              ELSE status
            END,
            paid_at = CASE WHEN GREATEST(0, amount_paid - ${alloc.amountAllocated}) <= 0.01 THEN NULL ELSE paid_at END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}
      `;
    }

    // (4) The journal LAST: head locked and re-checked, matched line unmatched, head reversed (none when out, D8).
    if (!delegated && journalId && leg) {
      await lockJournalAndUnmatch(companyId, journalId, leg, label);
      if (!leg.alreadyReversed) await reverseJournalEntry(companyId, leg.reverseId, userId);
    }
    await auditLeg?.();

    const cancelNote = reason ? ` [CANCELLED: ${reason}]` : ' [CANCELLED]';
    const updated = (await sql`
      UPDATE customer_payments
      SET status = 'cancelled',
          description = COALESCE(description, '') || ${cancelNote}
      WHERE id = ${id} AND company_id = ${companyId} RETURNING *
    `) as Row[];

    log.info('Cancelled customer payment', { id, reason }, 'accounting');
    return mapPaymentRow(updated[0]!);
  } catch (err) {
    log.error('Failed to cancel customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

// Invoice posting lives in its own file so the VAT-guard allowlist entry for
// its `vatType: 'standard'` covers that poster alone. Re-exported for callers.
export { postCustomerInvoiceToGL } from './customerInvoiceGlPosting';

// ── Private mapper ────────────────────────────────────────────────────────────
import type { CustomerPaymentStatus } from '../../types/ar.types';
import { assertMayReverseMatchedLeg } from '../bank/bankReversalGate';

function mapPaymentRow(row: Row): CustomerPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    clientId: String(row.client_id),
    paymentDate: fmtDate(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as CustomerPayment['paymentMethod'],
    bankReference: row.bank_reference ? String(row.bank_reference) : undefined,
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as CustomerPaymentStatus,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : undefined,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    allocatedAmount: row.allocated_amount !== undefined ? Number(row.allocated_amount) : 0,
  };
}
