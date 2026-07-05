/**
 * Customer invoice cancellation with GL reversal (A–Z programme P1.1).
 *
 * Audit C1 (2026-07-04): cancel was a bare status flip — the approval journal
 * stayed posted, permanently overstating AR/Revenue/VAT for every
 * approved-then-cancelled invoice (Britech INV0000134 R28,750).
 *
 * Rules:
 *   - A posted invoice's journal is reversed FIRST (reverseJournalEntry posts
 *     the reversal into the current open period and marks the original
 *     'reversed'). If posting is blocked — e.g. the fiscal period is locked —
 *     the error propagates and the cancel never happens. The caller runs
 *     inside the withAuth request transaction, so partial state cannot commit.
 *   - Invoices with payments/credits applied (amount_paid > 0) cannot be
 *     cancelled; those amounts must be reversed/unallocated first.
 *   - Cancel is terminal: an already-cancelled invoice cannot be re-cancelled
 *     (and the API blocks approve/send on cancelled invoices).
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';

type Row = Record<string, unknown>;

export interface CancelCustomerInvoiceResult {
  status: 'cancelled';
  reversalJournalEntryId: string | null;
}

/**
 * Cancel a customer invoice, reversing its GL journal when one was posted.
 * Returns null when no invoice with this id belongs to the company.
 * Throws on guard violations (already cancelled, payments applied) and on
 * reversal failure (e.g. locked fiscal period) — in which case nothing flips.
 */
export async function cancelCustomerInvoice(
  companyId: string,
  invoiceId: string,
  userId: string,
): Promise<CancelCustomerInvoiceResult | null> {
  const rows = (await sql`
    SELECT id, status, amount_paid, gl_journal_entry_id
    FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (rows.length === 0) return null;
  const inv = rows[0]!;

  const status = String(inv.status);
  if (status === 'cancelled') {
    throw new Error('Invoice is already cancelled');
  }
  if (Number(inv.amount_paid) > 0) {
    throw new Error(
      'Cannot cancel an invoice with payments or credits applied — reverse or unallocate them first',
    );
  }

  // Reverse the approval journal BEFORE the status flip so a blocked reversal
  // (locked period, already-reversed journal) aborts the whole cancel.
  let reversalJournalEntryId: string | null = null;
  if (inv.gl_journal_entry_id) {
    const reversal = await reverseJournalEntry(
      companyId,
      String(inv.gl_journal_entry_id),
      userId,
    );
    reversalJournalEntryId = reversal.id;
  }

  await sql`
    UPDATE customer_invoices
    SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `;

  log.info(
    'Customer invoice cancelled',
    { invoiceId, reversalJournalEntryId, hadJournal: Boolean(inv.gl_journal_entry_id) },
    'accounting',
  );
  return { status: 'cancelled', reversalJournalEntryId };
}
