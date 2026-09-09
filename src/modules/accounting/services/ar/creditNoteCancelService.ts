/**
 * Credit-note CANCEL and APPLY — the un-posting and allocation paths.
 *
 * Cancel reverses the approval journal and un-applies exactly what the note
 * credited (`applied_amount`, migration 529), never its face value. Apply is
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
import { withCustomerInvoiceLock } from './customerInvoiceLock';
import { recomputeInvoiceStatus } from './invoiceStatusRecompute';
import { mapRow } from './creditNoteMapper';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';

export async function cancelCreditNote(companyId: string, 
  id: string,
  userId: string,
  reason?: string,
  // Same reason as approveCreditNote: the REVERSING entry is a ledger write of
  // its own and must carry the agent stamp, or an MCP cancellation reverses a
  // journal under the token owner's name.
  opts?: PostingActorOpts,
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

    // Reverse the GL journal entry. (It used to manage its own transaction; it
    // now runs on the ALS-bound request client like everything else, so the
    // reversal and the un-apply below commit or roll back together.)
    if (cn.gl_journal_entry_id) {
      await reverseJournalEntry(
        companyId,
        String(cn.gl_journal_entry_id),
        userId,
        actorMeta(opts),
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
    const updated = cancelledRows[0];
    if (!updated) throw new Error(`Credit note ${id} vanished while being cancelled.`);

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
  // The note is locked FIRST, before the invoice is read — the same order
  // approve and cancel use. Two reasons, both load-bearing:
  //
  //   1. This was the one credit_notes write path the row-lock change missed.
  //      It read status unlocked and then wrote an absolute amount_paid
  //      computed in JS, so one approved note applied concurrently to two
  //      different invoices was consumed twice: 230 of receivable reduced for
  //      115 of GL credit, and a later cancel un-applies from only one of them.
  //   2. Locking note-then-invoice everywhere is what stops a concurrent MCP
  //      cancel and UI apply taking the two rows in opposite orders and
  //      deadlocking (40P01 surfaces as GENERIC_FAILURE, which does not read as
  //      retryable to an agent).
  const cn = await lockCreditNoteForUpdate(companyId, creditNoteId);
  if (!cn) throw new Error('Credit note not found');
  if (String(cn.status) !== 'approved') throw new Error('Credit note must be approved before applying');
  if (String(cn.type) !== 'customer') throw new Error('Only customer credit notes can be applied to invoices');

  // ...and the invoice SECOND, also locked. Without FOR UPDATE, `outstanding`
  // below is derived from a row another request may already be changing, and
  // the absolute write erases whatever it wrote: a second credit note or a
  // receipt allocation applied concurrently vanishes from amount_paid while
  // still counting as applied. The note-then-invoice order is the one the
  // comment above establishes, so the lock added here does not create a cycle.
  const invRows = await withCustomerInvoiceLock(
    'applyCreditNoteToInvoice',
    `Invoice ${invoiceId}`,
    async () => (await sql`
      SELECT * FROM customer_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
      FOR UPDATE
    `) as Record<string, unknown>[],
  );
  if (invRows.length === 0) throw new Error('Invoice not found');
  const inv = invRows[0]!;

  const clientMatch = String(inv.client_id || inv.customer_id) === String(cn.client_id);
  if (!clientMatch) throw new Error('Invoice and credit note must belong to the same customer');

  const outstanding = Math.max(0, Number(inv.total_amount) - Number(inv.amount_paid));
  const applyAmount = Math.min(Number(cn.total_amount), outstanding);
  if (applyAmount <= 0) throw new Error('Invoice has no outstanding balance');

  await sql`
    UPDATE customer_invoices
    SET amount_paid = COALESCE(amount_paid, 0) + ${applyAmount}
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
  const updated = appliedRows[0];
  if (!updated) throw new Error(`Credit note ${creditNoteId} vanished while being applied.`);

  log.info('Applied credit note to invoice', { creditNoteId, invoiceId, applyAmount, userId }, 'accounting');
  return mapRow(updated);
}

