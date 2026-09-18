/**
 * Applying a credit note's unused remainder to the contact's open documents.
 *
 * WHAT THIS IS NOT. It posts NO journal: `approveCreditNote` posted the note's
 * journal when it was approved, and the remainder this settles is already on
 * the control account. Applying it moves the subledger only.
 *
 * WHY IT IS GUARDED BY A TABLE CHECK. `credit_note_allocations` — one row per
 * document a note was consumed against — arrives with the credit-note FIFO
 * work, not with this tool. The pre-existing `applyCreditNoteToInvoice` can
 * only spend a whole note against ONE invoice and sets status 'applied'
 * outright, which cannot express a note partly consumed across three bills.
 * So the back-fill writes the allocation rows itself when the table is there
 * and REFUSES the note by name when it is not, rather than half-applying it
 * through a path that would then disagree with `cancel_credit_note`.
 *
 * THE TABLE IS NOT CREATED BY THIS BRANCH. It arrives with the credit-note
 * work's own migration, and a database that has not had that migration takes
 * the refusal path in the orchestrator instead. Everything below was written
 * against the real table as it stands in `isaflow_dev`, not against a guess:
 * `company_id` is NOT NULL on it, and `(credit_note_id, invoice_id)` is UNIQUE,
 * which is what the ON CONFLICT below answers to.
 *
 * ── THE REMAINDER IS RE-READ UNDER A ROW LOCK ───────────────────────────────
 *
 * The population's remainder is a figure from before this transaction started,
 * and spending it unchecked is a check-then-act window with real money in it.
 * Two back-fill runs over one company, or one run racing a manual
 * `applyCreditNoteToInvoice`, both read "R50 unapplied" and both write R50 —
 * and because the allocation row ACCUMULATES on conflict, the note ends
 * consumed for twice its own total with `applied_amount` to match. The bills
 * are then credited for money the note never carried.
 *
 * So the note is locked first, `total_amount - applied_amount` is re-derived
 * from the locked row, and the plan is built against THAT. A second run blocks
 * on the lock, re-reads a remainder of zero, and applies nothing — which is the
 * same idempotence the payment path gets from `lockSupplierPaymentForUpdate`.
 *
 * LOCK ORDER IS NOTE-THEN-DOCUMENT, and the open-document fetch lives inside
 * this function for exactly that reason. `applyCreditNoteToInvoice` and
 * `cancelCreditNote` both take the note before the invoice; fetching the open
 * documents FOR UPDATE before locking the note would give this path the
 * opposite order and a reachable deadlock (40P01) against either of them.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { EPS, planGreedyAllocations, round2 } from './autoAllocateStrategy';
import { fetchOpenDocuments } from './autoApplyBackfillPopulation';
import type { PlannedLine, Subledger } from './autoApplyBackfillPlan';

/**
 * Statuses a note may still be applied from. A note that reached 'applied',
 * 'cancelled' or is back at 'draft' between the population read and here is
 * REFUSED rather than topped up — the run reports it in `failed` and a human
 * decides, which is the only safe answer for a document whose state changed
 * underneath the plan.
 */
const APPLICABLE_STATUSES = new Set(['approved', 'partially_applied']);

/**
 * Consume a credit note's remaining balance across the contact's open
 * documents. Returns the lines written, empty when the note has nothing left or
 * there is nothing open to take it.
 */
export async function applyCreditNoteRemainder(args: {
  companyId: string;
  subledger: Subledger;
  creditNoteId: string;
  oldestFirst: boolean;
  userId: string;
}): Promise<PlannedLine[]> {
  const { companyId, subledger, creditNoteId, oldestFirst, userId } = args;

  // THE NOTE FIRST — see the lock-order note in the header.
  const note = await lockCreditNoteForUpdate(companyId, creditNoteId);
  if (!note) throw new Error(`Credit note ${creditNoteId} not found`);

  // Re-derived from the LOCKED row, never from the population's figure.
  const appliedBefore = Number(note.applied_amount ?? 0);
  const total = Number(note.total_amount);
  const remainder = round2(total - appliedBefore);

  // THE REMAINDER IS TESTED BEFORE THE STATUS, and the order is the difference
  // between a clean re-run and an alarming one. A note another run has just
  // finished is at 'applied' with nothing left: that is this run having no work
  // to do, not a fault, and reporting it in `failed` would make the second pass
  // of any back-fill read as broken. A note with money still on it whose status
  // has moved is the real refusal — 'cancelled' resets `applied_amount` to 0,
  // so a cancelled note arrives here with its whole total apparently available
  // and MUST NOT be spent.
  if (remainder <= EPS) return [];
  const status = String(note.status);
  if (!APPLICABLE_STATUSES.has(status)) {
    throw new Error(
      `Credit note ${creditNoteId} is "${status}" and can no longer be applied — `
      + 'it changed after this run read it.',
    );
  }

  const entityId = subledger === 'ap'
    ? String(note.supplier_id)
    : String(note.client_id);
  const open = await fetchOpenDocuments(companyId, subledger, entityId, oldestFirst, true);
  const planned = planGreedyAllocations(remainder, open);
  if (planned.length === 0) return [];

  const kind = subledger === 'ap' ? 'supplier' : 'customer';
  const lines: PlannedLine[] = [];
  for (const line of planned) {
    // ACCUMULATES on conflict rather than replacing. `(credit_note_id,
    // invoice_id)` is UNIQUE, so a note applied to one document twice — a
    // partly consumed note that a later run takes further — has one row whose
    // amount is the total consumed. Replacing it would erase the first
    // application while `applied_amount` still counted it. The lock above is
    // what keeps the accumulated total inside `total_amount`.
    await sql`
      INSERT INTO credit_note_allocations
        (company_id, credit_note_id, invoice_id, amount_allocated)
      VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${line.invoiceId}::UUID, ${line.amount})
      ON CONFLICT (credit_note_id, invoice_id) DO UPDATE
        SET amount_allocated = credit_note_allocations.amount_allocated + EXCLUDED.amount_allocated
    `;
    if (subledger === 'ap') {
      await sql`
        UPDATE supplier_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    } else {
      await sql`
        UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
    await recomputeInvoiceStatus(companyId, kind, line.invoiceId);
    lines.push({
      document_id: line.invoiceId,
      document_number: open.find((d) => d.invoiceId === line.invoiceId)?.invoiceNumber ?? '',
      // Filled in by the caller, in one statement for the whole run.
      invoice_date: null,
      amount: line.amount,
    });
  }

  const applied = lines.reduce((s, l) => round2(s + l.amount), 0);
  // Written as an ABSOLUTE total computed from the locked row, not as an
  // increment: the lock makes `appliedBefore` current, and an absolute write
  // cannot drift from the allocation rows the way `applied_amount + x` would if
  // this function were ever reached twice inside one transaction.
  const appliedAfter = round2(appliedBefore + applied);
  await sql`
    UPDATE credit_notes
    SET applied_amount = ${appliedAfter},
        status = ${appliedAfter >= round2(total - EPS) ? 'applied' : 'partially_applied'},
        updated_at = NOW()
    WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Back-fill applied credit note remainder', {
    creditNoteId, subledger, lines: lines.length, applied, appliedAfter, userId,
  }, 'accounting');
  return lines;
}
