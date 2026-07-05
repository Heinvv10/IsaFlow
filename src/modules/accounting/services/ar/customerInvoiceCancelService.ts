/**
 * Customer Invoice Cancellation Service
 *
 * Cancelling an approved customer invoice must UNDO its accounting side-effects,
 * not merely flip status. When an invoice is approved, `postCustomerInvoiceToGL`
 * posts a journal (DR Trade Debtors / CR Revenue / CR VAT Output). If cancel only
 * set status='cancelled', that journal stayed posted forever, permanently
 * overstating AR, Revenue and VAT Output. This service reverses the posted
 * journal so the ledger no longer carries the cancelled invoice.
 *
 * Outstanding balance: customer_invoices.balance is a GENERATED column
 * (total_amount - amount_paid) and cannot be written directly. It is not the
 * source of truth for outstanding AR — every aging/KPI query filters by status
 * via AR_OPEN_STATUSES, which excludes 'cancelled'. So flipping status to
 * 'cancelled' is what removes the invoice from outstanding AR; there is no
 * separate outstanding field to zero.
 *
 * Atomicity: all queries run on the ALS-bound `sql` client so they participate
 * in the outer withAuth request transaction (same pattern as
 * cancelCustomerPayment). The gl_account_balances cache is maintained
 * automatically by the trg_gl_je_status_balance trigger (migration 499): the
 * reversal contra entry's draft->posted transition fires a full recompute of the
 * affected accounts from posted lines, which now includes both the (still-posted)
 * original and the contra, netting them to zero — no explicit cache work here.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseJournalEntry } from '../gl/journalEntryService';

type Row = DbRow;

/** Amounts below this (in currency units) are treated as zero to absorb rounding. */
const ZERO_TOLERANCE = 0.005;

/** Thrown when the invoice does not exist or does not belong to the company. */
export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} not found`);
    this.name = 'InvoiceNotFoundError';
  }
}

/** Thrown when the invoice has settled or pending payments and cannot be cancelled. */
export class InvoiceHasPaymentsError extends Error {
  constructor() {
    super('Cannot cancel invoice with payments');
    this.name = 'InvoiceHasPaymentsError';
  }
}

export interface CancelCustomerInvoiceResult {
  id: string;
  /** Id of the reversal journal entry, or null when nothing was reversed. */
  reversedJournalEntryId: string | null;
}

/**
 * Cancel a customer invoice: block if it has payments, reverse its posted GL
 * journal if present and not already reversed, then set status='cancelled' and
 * zero the outstanding balance. Idempotent — cancelling an already-cancelled
 * invoice is a no-op, and an already-reversed journal is never reversed twice.
 */
export async function cancelCustomerInvoice(
  companyId: string,
  invoiceId: string,
  userId: string,
): Promise<CancelCustomerInvoiceResult> {
  try {
    const invRows = (await sql`
      SELECT id, status, amount_paid, gl_journal_entry_id
      FROM customer_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    if (invRows.length === 0) throw new InvoiceNotFoundError(invoiceId);
    const inv = invRows[0]!;

    // Idempotent: an already-cancelled invoice has already had its journal
    // reversed (or never had one). Do not reverse again or re-zero.
    if (String(inv.status) === 'cancelled') {
      return { id: invoiceId, reversedJournalEntryId: null };
    }

    // Block cancel when the invoice carries settled payments (mirrors the
    // supplier-invoice "Cannot cancel invoice with payments" rule).
    if (Number(inv.amount_paid ?? 0) > ZERO_TOLERANCE) {
      throw new InvoiceHasPaymentsError();
    }

    // Also block on live (non-cancelled) payment allocations, which catch
    // pending/draft payments that have not yet incremented amount_paid.
    const allocRows = (await sql`
      SELECT COALESCE(SUM(cpa.amount_allocated), 0) AS allocated
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id
      WHERE cpa.invoice_id = ${invoiceId}::UUID
        AND cp.company_id = ${companyId}::UUID
        AND cp.status <> 'cancelled'
    `) as Row[];
    if (Number(allocRows[0]!.allocated ?? 0) > ZERO_TOLERANCE) {
      throw new InvoiceHasPaymentsError();
    }

    // Reverse the posted GL journal, if one exists and is still posted and not
    // already reversed. A draft invoice (no journal) skips this. Note: after the
    // reversal-semantics fix an already-reversed entry KEEPS status='posted', so
    // idempotency is checked via reversed_at, not status.
    let reversedJournalEntryId: string | null = null;
    const journalEntryId = inv.gl_journal_entry_id ? String(inv.gl_journal_entry_id) : null;
    if (journalEntryId) {
      const jeRows = (await sql`
        SELECT status, reversed_at FROM gl_journal_entries
        WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID
      `) as Row[];
      if (jeRows.length > 0 && String(jeRows[0]!.status) === 'posted' && jeRows[0]!.reversed_at == null) {
        const reversal = await reverseJournalEntry(companyId, journalEntryId, userId);
        reversedJournalEntryId = reversal.id;
      }
    }

    // Flip status to 'cancelled', which removes the invoice from all
    // outstanding-AR reporting (AR_OPEN_STATUSES excludes it). The `balance`
    // column is GENERATED (total_amount - amount_paid) and derives itself;
    // total_amount / subtotal / tax_amount / amount_paid are historical facts
    // and are deliberately left untouched.
    await sql`
      UPDATE customer_invoices
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;

    log.info('Cancelled customer invoice', { invoiceId, reversedJournalEntryId }, 'accounting');
    return { id: invoiceId, reversedJournalEntryId };
  } catch (err) {
    log.error('Failed to cancel customer invoice', { invoiceId, error: err }, 'accounting');
    throw err;
  }
}
