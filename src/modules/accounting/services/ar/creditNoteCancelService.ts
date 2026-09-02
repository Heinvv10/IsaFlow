/**
 * Credit-note CANCEL and APPLY — the un-posting and allocation paths.
 *
 * Cancel reverses the approval journal and un-applies exactly what the note
 * credited (`applied_amount`, migration 527), never its face value. Apply is
 * the manual allocation of an already-approved note to one invoice, capped at
 * that invoice's outstanding balance.
 *
 * Re-exported through creditNoteService — see creditNoteApproveService.ts.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { CreditNote } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';
import { lockCreditNoteForUpdate } from './creditNoteLock';
import { recomputeInvoiceStatus } from './invoiceStatusRecompute';
import { mapRow } from './creditNoteMapper';

export async function cancelCreditNote(companyId: string, 
  id: string,
  userId: string,
  reason?: string,
  // Same reason as approveCreditNote: the REVERSING entry is a ledger write of
  // its own and must carry the agent stamp, or an MCP cancellation reverses a
  // journal under the token owner's name.
  opts?: { postingAgent?: string },
): Promise<CreditNote> {
  try {
    // Same check-then-act window as approve: two concurrent cancellations would
    // each reverse the journal, leaving the note over-reversed and the invoice
    // credit removed twice.
    const cn = await lockCreditNoteForUpdate(companyId, id);
    if (!cn) throw new Error(`Credit note ${id} not found`);
    // 'applied' is cancellable too (PR #203 review HIGH): linked notes land
    // 'applied' at approve (N6), and the un-apply + GL-reversal below already
    // handles the applied state — restricting to 'approved' made every
    // linked/applied note permanently uncancellable.
    if (String(cn.status) !== 'approved' && String(cn.status) !== 'applied') {
      throw new Error(`Cannot cancel credit note with status: ${cn.status}`);
    }

    // Reverse GL journal entry — manages its own transaction, must stay outside
    if (cn.gl_journal_entry_id) {
      await reverseJournalEntry(
        companyId,
        String(cn.gl_journal_entry_id),
        userId,
        opts?.postingAgent ? { postingAgent: opts.postingAgent } : undefined,
      );
    }

    // Un-apply exactly what was applied, never the note's face value. The apply
    // path caps at the invoice's outstanding balance (min(total, outstanding)),
    // so reversing total_amount erased real cash receipts: an invoice of 1000
    // with 950 paid absorbs only 50 of a 115 note, and un-crediting 115 left it
    // showing 115 outstanding against a true 50.
    //
    // The guard is `amount_paid >= X` rather than GREATEST(0, ...): flooring at
    // zero silently absorbs exactly the corruption worth hearing about, so a
    // row that cannot absorb the reversal refuses loudly instead.
    const unapply = Number(cn.applied_amount ?? 0);
    if (unapply > 0) {
      const invoiceTable = String(cn.type) === 'customer' ? cn.customer_invoice_id : cn.supplier_invoice_id;
      if (String(cn.type) === 'customer' && invoiceTable) {
        const done = (await sql`
          UPDATE customer_invoices
          SET amount_paid = amount_paid - ${unapply}
          WHERE id = ${invoiceTable}::UUID AND company_id = ${companyId}::UUID
            AND amount_paid >= ${unapply}
          RETURNING id
        `) as Record<string, unknown>[];
        if (done.length === 0) {
          throw new Error(
            `Cannot cancel credit note ${id}: invoice ${String(invoiceTable)} has less applied than the ${unapply} this note credited.`,
          );
        }
        await recomputeInvoiceStatus(companyId, 'customer', String(invoiceTable));
      } else if (String(cn.type) === 'supplier' && invoiceTable) {
        const done = (await sql`
          UPDATE supplier_invoices
          SET amount_paid = amount_paid - ${unapply}
          WHERE id = ${invoiceTable}::UUID AND company_id = ${companyId}::UUID
            AND amount_paid >= ${unapply}
          RETURNING id
        `) as Record<string, unknown>[];
        if (done.length === 0) {
          throw new Error(
            `Cannot cancel credit note ${id}: supplier invoice ${String(invoiceTable)} has less applied than the ${unapply} this note credited.`,
          );
        }
        // The supplier branch previously recomputed nothing, so a cancelled
        // supplier credit left the bill showing 'paid' on a restored balance.
        await recomputeInvoiceStatus(companyId, 'supplier', String(invoiceTable));
      }
    }

    const cancelledRows = (await sql`
      UPDATE credit_notes
      SET status = 'cancelled', cancelled_by = ${userId}::UUID,
          cancelled_at = NOW(), cancel_reason = ${reason || null},
          applied_amount = 0
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Record<string, unknown>[];
    const updated = cancelledRows[0] as Record<string, unknown>;

    log.info('Cancelled credit note', { id, reason }, 'accounting');
    return mapRow(updated);
  } catch (err) {
    log.error('Failed to cancel credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function applyCreditNoteToInvoice(
  companyId: string,
  creditNoteId: string,
  invoiceId: string,
  userId: string
): Promise<CreditNote> {
  const cnRows = (await sql`
    SELECT * FROM credit_notes WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (cnRows.length === 0) throw new Error('Credit note not found');
  const cn = cnRows[0]!;
  if (String(cn.status) !== 'approved') throw new Error('Credit note must be approved before applying');
  if (String(cn.type) !== 'customer') throw new Error('Only customer credit notes can be applied to invoices');

  const invRows = (await sql`
    SELECT * FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (invRows.length === 0) throw new Error('Invoice not found');
  const inv = invRows[0]!;

  const clientMatch = String(inv.client_id || inv.customer_id) === String(cn.client_id);
  if (!clientMatch) throw new Error('Invoice and credit note must belong to the same customer');

  const outstanding = Math.max(0, Number(inv.total_amount) - Number(inv.amount_paid));
  const applyAmount = Math.min(Number(cn.total_amount), outstanding);
  if (applyAmount <= 0) throw new Error('Invoice has no outstanding balance');

  const newPaid = Number(inv.amount_paid) + applyAmount;
  await sql`
    UPDATE customer_invoices
    SET amount_paid = ${newPaid}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
  `;
  await recomputeInvoiceStatus(companyId, 'customer', invoiceId);
  const appliedRows = (await sql`
    UPDATE credit_notes
    SET status = 'applied', customer_invoice_id = ${invoiceId}::UUID, updated_at = NOW(),
        applied_amount = ${applyAmount}
    WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}
    RETURNING *
  `) as Record<string, unknown>[];
  const updated = appliedRows[0] as Record<string, unknown>;

  log.info('Applied credit note to invoice', { creditNoteId, invoiceId, applyAmount, userId }, 'accounting');
  return mapRow(updated);
}

