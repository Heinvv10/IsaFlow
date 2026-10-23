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
import { assertStoredDocumentSettleable } from '../shared/documentCurrency';
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
import {
  assertAllocationsMatchApplied,
  deriveCreditNoteStatus,
  listCreditNoteAllocations,
  reverseCreditNoteApplications,
} from '../shared/creditNoteFifo';
import { lockInvoicesForUpdate, UNAPPLICABLE_STATUSES } from '../shared/creditNoteApplicationWrites';
import { round2 } from '../shared/autoAllocateStrategy';
import { mapRow } from './creditNoteMapper';
import { lockInvoiceCreditNotes } from './creditNotePostingChecks';
import { recordLateLinkExcess } from './invoiceRevenuePosting';
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
    const restored = await reverseCreditNoteApplications(
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

    log.info('Cancelled credit note', {
      id, reason, restoredDocuments: restored.length,
    }, 'accounting');
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
  // 'partially_applied' is applicable too: what is left of the note is real
  // credit, and refusing here would strand it the moment the FIFO walk could
  // not place the whole face value.
  if (String(cn.status) !== 'approved' && String(cn.status) !== 'partially_applied') {
    throw new Error('Credit note must be approved before applying');
  }
  if (String(cn.type) !== 'customer') throw new Error('Only customer credit notes can be applied to invoices');
  // Next lock after the note row, before the invoice's: approveCreditNote's order (ar/.claude.md), so the
  // allocation rows an approval of another note on this invoice reads cannot change under it.
  await lockInvoiceCreditNotes(invoiceId);

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

  // The status guard the CREATE path already applies to a link
  // (creditNoteLinkService), which this path never had: it would credit a draft
  // or cancelled invoice — a document that has posted nothing, so reducing its
  // balance moves a receivable the ledger does not carry. Same set the FIFO
  // walk refuses on, so the manual and automatic paths agree about eligibility.
  const invStatus = String(inv.status ?? '');
  if (UNAPPLICABLE_STATUSES.customer.includes(invStatus)) {
    throw new Error(`Cannot apply a credit note to an invoice with status: ${invStatus}`);
  }

  // FX PR0: neither a foreign note nor a foreign invoice can be settled, whatever the switch.
  await assertStoredDocumentSettleable(companyId, 'credit_note', creditNoteId);
  await assertStoredDocumentSettleable(companyId, 'customer_invoice', invoiceId);

  // The column and the rows must agree before this extends either — an
  // unattributable legacy note is reconciled by hand, never silently extended.
  await assertAllocationsMatchApplied(companyId, creditNoteId, Number(cn.applied_amount ?? 0));

  const outstanding = Math.max(0, round2(Number(inv.total_amount) - Number(inv.amount_paid)));
  // The note's REMAINING credit, not its face value: a partly applied note has
  // already consumed some of itself, and applying the face value again would
  // credit the same money twice.
  const alreadyApplied = round2(Number(cn.applied_amount ?? 0));
  const available = round2(Number(cn.total_amount) - alreadyApplied);
  const applyAmount = round2(Math.min(available, outstanding));
  // Whole cents: a credit note may clear a one-cent remnant (the invoice reads 'partially_paid' until it does).
  if (applyAmount <= 0) throw new Error('Invoice has no outstanding balance');

  // The allocation row, then the money: a row that exists without the balance
  // move is the one inconsistency `credit_note_allocations` was added to make
  // impossible, and its UNIQUE refuses a second application to the same pair.
  await sql`
    INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
    VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${invoiceId}::UUID, ${applyAmount})
  `;
  await sql`
    UPDATE customer_invoices
    SET amount_paid = COALESCE(amount_paid, 0) + ${applyAmount}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
  `;
  await recomputeInvoiceStatus(companyId, 'customer', invoiceId);
  const nowApplied = round2(alreadyApplied + applyAmount);
  const appliedRows = (await sql`
    UPDATE credit_notes
    SET status = ${deriveCreditNoteStatus(nowApplied, Number(cn.total_amount), 'customer')},
        customer_invoice_id = COALESCE(customer_invoice_id, ${invoiceId}::UUID), updated_at = NOW(),
        applied_amount = ${nowApplied}
    WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}
    RETURNING *
  `) as Record<string, unknown>[];
  const updated = appliedRows[0];
  if (!updated) throw new Error(`Credit note ${creditNoteId} vanished while being applied.`);
  // A note unlinked until now took nothing from this invoice's legs: record so, or it would be replayed.
  await recordLateLinkExcess(companyId, cn, invoiceId);

  log.info('Applied credit note to invoice', { creditNoteId, invoiceId, applyAmount, userId }, 'accounting');
  return mapRow(updated);
}

