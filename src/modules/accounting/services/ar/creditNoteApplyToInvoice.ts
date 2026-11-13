/**
 * Credit-note APPLY from the UI (REST `credit-notes-action` apply): the manual
 * allocation of an already-approved CUSTOMER note to one invoice, capped at that
 * invoice's outstanding balance and at what the note's journal posted.
 *
 * Split from creditNoteCancelService.ts (300-line cap), which re-exports it.
 * Same rules as `apply_credit_note` (brief step 7): a note with no live journal
 * is refused, an application never exceeds the posted credit, and after the
 * writes the documents' measured movement must equal the note's (else a
 * `CreditNoteApplicationDriftError`, which the route answers 5xx so it rolls back).
 */
import { sql } from '@/lib/neon';
import { assertStoredDocumentSettleable } from '../shared/documentCurrency';
import { log } from '@/lib/logger';
import type { CreditNote } from '../../types/ar.types';
import { lockCreditNoteForUpdate } from './creditNoteLock';
import { withCustomerInvoiceLock } from './customerInvoiceLock';
import { assertAllocationsMatchApplied, deriveCreditNoteStatus } from '../shared/creditNoteFifo';
import { UNAPPLICABLE_STATUSES, writeApplication } from '../shared/creditNoteApplicationWrites';
import {
  CreditNotePostedCreditError, assertApplicationWithinPostedCredit, postedCreditRefusal, readNotePostedCredit,
} from '../shared/creditNotePostedCredit';
import { CreditNoteApplicationDriftError, assertApplicationRecorded } from '../shared/creditNoteApplicationInvariant';
import { round2 } from '../shared/autoAllocateStrategy';
import { mapRow } from './creditNoteMapper';
import { lockInvoiceCreditNotes } from './creditNotePostingChecks';
import { recordLateLinkExcess } from './invoiceRevenuePosting';

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
  // credit the same money twice. Capped at what its journal POSTED (brief step 7,
  // the same rule as apply_credit_note): a note with no live journal is refused.
  const alreadyApplied = round2(Number(cn.applied_amount ?? 0));
  const total = round2(Number(cn.total_amount));
  const { posted } = await readNotePostedCredit(companyId, cn, 'customer');
  const available = round2(Math.min(total, posted) - alreadyApplied);
  if (available <= 0 && posted < total) {
    throw new CreditNotePostedCreditError(postedCreditRefusal(String(cn.credit_note_number), posted, alreadyApplied, total));
  }
  const applyAmount = round2(Math.min(available, outstanding));
  // Whole cents: a credit note may clear a one-cent remnant (the invoice reads 'partially_paid' until it does).
  if (applyAmount <= 0) throw new Error('Invoice has no outstanding balance');

  // The engine's own row writer (row, then the money, then the status): its UNIQUE refuses a second application to
  // the same pair, and it reports what amount_paid measurably moved for the invariant below.
  const paidMoved = await writeApplication(companyId, creditNoteId, 'customer', { invoiceId, amount: applyAmount });
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
  // After the writes: any failure here is a defect, raised as one so the route answers 5xx and rolls them back.
  await assertApplicationRecordedOrDrift(companyId, cn, alreadyApplied, nowApplied, paidMoved);
  // A note unlinked until now took nothing from this invoice's legs: record so, or it would be replayed.
  await recordLateLinkExcess(companyId, cn, invoiceId);

  log.info('Applied credit note to invoice', { creditNoteId, invoiceId, applyAmount, userId }, 'accounting');
  return mapRow(updated);
}

/** Both application invariants after the REST apply's writes; every failure is a `CreditNoteApplicationDriftError`. */
async function assertApplicationRecordedOrDrift(
  companyId: string, cn: Record<string, unknown>, before: number, after: number, paidMoved: number,
): Promise<void> {
  const number = String(cn.credit_note_number);
  try {
    await assertApplicationWithinPostedCredit(companyId, cn, 'customer', before, after);
  } catch (err) {
    if (err instanceof CreditNotePostedCreditError) throw new CreditNoteApplicationDriftError(err.message);
    throw err;
  }
  assertApplicationRecorded(number, { appliedBefore: before, appliedAfter: after, paidMoved });
}
