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
import { withSupplierInvoiceLock } from '../ap/supplierInvoiceLock';
import { recomputeInvoiceStatus } from './invoiceStatusRecompute';
import { listCreditNoteAllocations } from '../shared/creditNoteFifo';
import { reverseCreditNoteApplications } from '../shared/creditNoteReverseApplications';
import { assertApplicationRecorded } from '../shared/creditNoteApplicationInvariant';
import { lockInvoicesForUpdate } from '../shared/creditNoteApplicationWrites';
import { round2 } from '../shared/autoAllocateStrategy';
import { mapRow } from './creditNoteMapper';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import { lockStandingChainHead } from '../shared/journalChainHead';
import { underFlowLockBudget } from '../core/rowLockBudget';

/** The states that have something to reverse. A draft has posted nothing. */
const CANCELLABLE_STATUSES = new Set(['approved', 'partially_applied', 'applied']);

export async function cancelCreditNote(companyId: string, 
  id: string,
  userId: string,
  reason?: string,
  // Same reason as approveCreditNote: the REVERSING entry is a ledger write of
  // its own and must carry the agent stamp, or an MCP cancellation reverses a
  // journal under the token owner's name.
  opts?: PostingActorOpts,
): Promise<CreditNote> {
  // Every lock of the cancel under ONE budget, plain UPDATEs included (D8 round 10, core/rowLockBudget).
  return underFlowLockBudget(`Credit note ${id}`, () => cancelCreditNoteInner(companyId, id, userId, reason, opts));
}

async function cancelCreditNoteInner(
  companyId: string, id: string, userId: string, reason: string | undefined, opts: PostingActorOpts | undefined,
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
    // 'partially_applied' joins the two: a note that consumed part of its face
    // value has both a journal to reverse and allocations to give back, so
    // excluding it would make exactly the notes the FIFO walk produces
    // uncancellable.
    if (!CANCELLABLE_STATUSES.has(String(cn.status))) {
      throw new Error(`Cannot cancel credit note with status: ${cn.status}`);
    }

    const side = String(cn.type) === 'customer' ? 'customer' as const : 'supplier' as const;

    // Reverse the GL journal entry. (It used to manage its own transaction; it
    // now runs on the ALS-bound request client like everything else, so the
    // reversal and the un-apply below commit or roll back together.)
    // At its reversal-chain HEAD (D8, shared/journalChainHead): after O <- R <- R2
    // the GL carries the note again through R2 while O is stamped reversed, and
    // reversing O threw "already reversed". A chain already out reverses nothing.
    // The DOCUMENTS this note credited first, in id order, then the journal head (D8 round 10, brk-d8c F3): the
    // head and the contra before the invoice inverted the bank line -> document -> journal order of a receipt
    // cancel or payment void on the same invoice, and the pair deadlocked (40P01 -> 500).
    const legacyDoc = side === 'customer' ? cn.customer_invoice_id : cn.supplier_invoice_id;
    await lockInvoicesForUpdate('cancelCreditNote', companyId, side, [
      ...(await listCreditNoteAllocations(companyId, id)).map((l) => l.invoiceId), ...(legacyDoc ? [String(legacyDoc)] : [])]);
    const head = cn.gl_journal_entry_id
      ? await lockStandingChainHead(companyId, String(cn.gl_journal_entry_id))
      : null;
    if (head) {
      await reverseJournalEntry(companyId, head, userId, actorMeta(opts));
    }

    // Un-apply exactly what was applied, never the note's face value, and do it
    // from the ALLOCATION ROWS rather than a single column: since migration 677
    // a note can be spread over several documents, and `applied_amount` cannot
    // say which. reverseCreditNoteApplications restores each document,
    // recomputes its status and deletes the rows, refusing loudly when a row
    // cannot absorb the reversal.
    const { lines: restored, paidMoved: restoredPaid } = await reverseCreditNoteApplications(
      companyId, id, side, Number(cn.applied_amount ?? 0),
    );

    // LEGACY FALLBACK. A note approved before migration 677 whose backfill could
    // not name a document — `applied_amount > 0` with no link — has no rows to
    // read. Its single linked document is the only thing it can have credited,
    // so the pre-677 path still runs for it. Dropping this would silently leave
    // those invoices over-credited after a cancel.
    const unapply = Number(cn.applied_amount ?? 0);
    if (restored.length === 0 && unapply > 0) {
      const invoiceTable = side === 'customer' ? cn.customer_invoice_id : cn.supplier_invoice_id;
      if (side === 'customer' && invoiceTable) {
        // Bounded like every other invoice row lock in this file: a bare
        // UPDATE waits on the row for as long as the holder lives, while this
        // request is itself holding the credit note.
        const done = await withCustomerInvoiceLock(
          'cancelCreditNote',
          `Invoice ${String(invoiceTable)}`,
          async () => (await sql`
            UPDATE customer_invoices
            SET amount_paid = amount_paid - ${unapply}
            WHERE id = ${invoiceTable}::UUID AND company_id = ${companyId}::UUID
              AND amount_paid >= ${unapply}
            RETURNING id
          `) as Record<string, unknown>[],
        );
        if (done.length === 0) {
          throw new Error(
            `Cannot cancel credit note ${id}: invoice ${String(invoiceTable)} has less applied than the ${unapply} this note credited.`,
          );
        }
        await recomputeInvoiceStatus(companyId, 'customer', String(invoiceTable));
      } else if (side === 'supplier' && invoiceTable) {
        const done = await withSupplierInvoiceLock(
          'cancelCreditNote',
          String(invoiceTable),
          async () => (await sql`
            UPDATE supplier_invoices
            SET amount_paid = amount_paid - ${unapply}
            WHERE id = ${invoiceTable}::UUID AND company_id = ${companyId}::UUID
              AND amount_paid >= ${unapply}
            RETURNING id
          `) as Record<string, unknown>[],
        );
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
    // Rows moved what they held; the legacy fallback (no rows) moves a document by the column alone and has no
    // rows to compare, so it is checked only for its own arithmetic above.
    if (restored.length > 0) {
      await assertApplicationRecorded(companyId, id, String(cn.credit_note_number), {
        rowsMoved: -restored.reduce((t, l) => round2(t + l.amount), 0), paidMoved: restoredPaid, appliedAfter: 0,
      });
    }

    log.info('Cancelled credit note', {
      id, reason, restoredDocuments: restored.length,
    }, 'accounting');
    return mapRow(updated);
  } catch (err) {
    log.error('Failed to cancel credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

// Split out for the 300-line cap; re-exported so every existing import keeps working.
export { applyCreditNoteToInvoice } from './creditNoteApplyToInvoice';
