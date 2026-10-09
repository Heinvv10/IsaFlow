/**
 * Apply an approved credit note to ONE document the caller names.
 *
 * Approval and `auto_apply_unapplied` apply credit oldest-first. A credit note
 * imported from Sage usually belongs to one specific invoice, and FIFO would
 * put it against whichever is oldest — the right total on the wrong documents,
 * which the aged reports then show. This is the instruction form: THIS note,
 * THAT document.
 *
 * It writes through the one application engine (`applyCreditNote`, with the
 * named document as the link and `autoApply: 'none'`), so what it writes is
 * cancellable by `cancel_credit_note` exactly like an approval's application,
 * and it posts NO journal: the note's journal already moved the control
 * account at approval; only the subledger moves here.
 *
 * WHAT IT ADDS OVER THE ENGINE is instruction semantics. The engine SKIPS a
 * linked document that is paid, draft or cancelled — right for an approval,
 * where the link is a hint, and wrong here, where a silent no-op reads as
 * success. So every reason the named document cannot take credit is a named
 * refusal, decided by `buildPlan` before anything is written, and run
 * identically by the dry run and the live call.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { EPS, round2 } from './autoAllocateStrategy';
import { APPLICABLE_CREDIT_NOTE_STATUSES } from './autoApplyBackfillApply';
import { applyCreditNote, deriveCreditNoteStatus, type CreditNoteSide } from './creditNoteFifo';
import { assertAllocationsMatchApplied, lockInvoicesForUpdate } from './creditNoteApplicationWrites';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import { assertStoredDocumentSettleable } from './documentCurrency';

/** A refusal whose message is safe to show the caller: it names no schema. */
export class CreditNoteApplyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditNoteApplyRefusal';
  }
}

export interface CreditNoteToDocumentInput {
  creditNoteId: string;
  invoiceId: string;
  /** At most this much. Omitted: the note's whole remainder, capped by the document. */
  amount?: number;
}

export interface CreditNoteToDocumentResult {
  creditNoteId: string;
  creditNoteNumber: string;
  side: CreditNoteSide;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  noteTotal: number;
  noteAppliedBefore: number;
  noteAppliedAfter: number;
  noteRemainderAfter: number;
  noteStatusAfter: string;
  invoiceOutstandingBefore: number;
  invoiceOutstandingAfter: number;
}

/** Every guard, from reads alone. The dry run returns this; the live call applies it. */
export async function planCreditNoteToDocument(
  companyId: string,
  input: CreditNoteToDocumentInput,
): Promise<CreditNoteToDocumentResult> {
  const rows = (await sql`
    SELECT * FROM credit_notes
    WHERE id = ${input.creditNoteId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return buildPlan(companyId, rows[0] ?? null, input);
}

/**
 * Apply it. The note is locked FIRST and the document SECOND — the order
 * `applyCreditNote`, cancel and approval all take, so no other order can
 * deadlock against them. The plan is then built from rows this transaction
 * HOLDS: two concurrent calls cannot spend the same remainder, and the figures
 * reported back (the document's outstanding before and after) are the ones the
 * write used, not a snapshot a concurrent payment has since moved. A document
 * deleted before the lock is read as absent and refused by name. The engine
 * locks the document again; re-locking a row this transaction holds is a no-op.
 */
export async function applyCreditNoteToDocument(
  companyId: string,
  input: CreditNoteToDocumentInput,
  userId: string,
): Promise<CreditNoteToDocumentResult> {
  const note = await lockCreditNoteForUpdate(companyId, input.creditNoteId);
  const checked = checkNote(note, input);
  await lockInvoicesForUpdate('applyCreditNoteToDocument', companyId, checked.side, [input.invoiceId]);
  const plan = await buildPlan(companyId, note, input);

  const application = await applyCreditNote({
    companyId,
    creditNoteId: plan.creditNoteId,
    side: plan.side,
    entityId: counterpartyOf(checked.note, plan.side),
    totalAmount: plan.amount,
    linkedInvoiceId: plan.invoiceId,
    // Belt and braces: `totalAmount` is already capped at the document's
    // outstanding balance, so no remainder is ever left for a walk. 'none' says
    // the intent anyway, should that cap ever move.
    autoApply: 'none',
    alreadyApplied: plan.noteAppliedBefore,
  });
  // Unreachable by construction: the document is locked and the plan refuses
  // anything the engine would not write (≤ a cent, a closed document). If the
  // engine still applied nothing, the plan and the engine disagree — a defect,
  // not the caller's problem. Thrown as a plain Error so the registry unwinds
  // and answers generically; a "retry" refusal would misstate the cause.
  const applied = round2(application.appliedAmount);
  if (applied <= EPS) {
    throw new Error(
      `applyCreditNoteToDocument: engine applied nothing to invoice ${plan.invoiceId} planned at `
      + `R${plan.amount.toFixed(2)} under lock — plan and engine disagree.`,
    );
  }

  const appliedAfter = round2(plan.noteAppliedBefore + applied);
  const statusAfter = deriveCreditNoteStatus(appliedAfter, plan.noteTotal);
  await sql`
    UPDATE credit_notes
    SET applied_amount = ${appliedAfter}, status = ${statusAfter}, updated_at = NOW()
    WHERE id = ${plan.creditNoteId}::UUID AND company_id = ${companyId}::UUID`;

  log.info('Credit note applied to a named document', {
    creditNoteId: plan.creditNoteId, invoiceId: plan.invoiceId, applied, appliedAfter, userId,
  }, 'accounting');

  return {
    ...plan,
    amount: applied,
    noteAppliedAfter: appliedAfter,
    noteRemainderAfter: round2(plan.noteTotal - appliedAfter),
    noteStatusAfter: statusAfter,
    invoiceOutstandingAfter: round2(plan.invoiceOutstandingBefore - applied),
  };
}

function counterpartyOf(note: DbRow, side: CreditNoteSide): string {
  return String(side === 'customer' ? note.client_id : note.supplier_id);
}

interface CheckedNote {
  note: DbRow;
  number: string;
  side: CreditNoteSide;
  total: number;
  appliedBefore: number;
  remainder: number;
}

/**
 * Every refusal that needs only the NOTE. Synchronous and read-free, so the
 * live path runs it before locking the document: a call against a draft,
 * cancelled or used-up note must not hold a row lock on a document it will
 * refuse to touch.
 */
function checkNote(note: DbRow | null, input: CreditNoteToDocumentInput): CheckedNote {
  if (!note) throw new CreditNoteApplyRefusal('Credit note not found.');
  const number = String(note.credit_note_number);
  const side: CreditNoteSide = note.type === 'supplier' ? 'supplier' : 'customer';
  const total = round2(Number(note.total_amount));
  const appliedBefore = round2(Number(note.applied_amount ?? 0));
  const remainder = round2(total - appliedBefore);
  const status = String(note.status);

  // 'applied' is a note with nothing left, not a wrong status — unless its
  // amounts say otherwise (a legacy row), which is named rather than misstated.
  // Every other status outside the applicable set is refused BEFORE the
  // remainder is read: cancelling resets applied_amount to 0, so a cancelled
  // note looks unspent.
  if (status === 'applied' && remainder > EPS) {
    throw new CreditNoteApplyRefusal(
      `Credit note ${number} is marked applied but R${remainder.toFixed(2)} of it is unapplied — its `
      + 'status and amounts disagree, so it cannot be applied here. Reconcile it by hand.',
    );
  }
  if (status === 'applied' || (APPLICABLE_CREDIT_NOTE_STATUSES.has(status) && remainder <= EPS)) {
    throw new CreditNoteApplyRefusal(`Credit note ${number} has nothing left to apply.`);
  }
  if (status === 'draft') {
    throw new CreditNoteApplyRefusal(
      `Credit note ${number} is a draft — approve it with approve_credit_note, which also applies it.`,
    );
  }
  if (!APPLICABLE_CREDIT_NOTE_STATUSES.has(status)) {
    throw new CreditNoteApplyRefusal(`Credit note ${number} is ${status} and cannot be applied.`);
  }
  if (input.amount !== undefined && !(Number.isFinite(input.amount) && input.amount > 0)) {
    throw new CreditNoteApplyRefusal('amount must be a positive number.');
  }
  return { note, number, side, total, appliedBefore, remainder };
}

async function buildPlan(
  companyId: string,
  noteRow: DbRow | null,
  input: CreditNoteToDocumentInput,
): Promise<CreditNoteToDocumentResult> {
  const { note, number, side, total, appliedBefore, remainder } = checkNote(noteRow, input);

  const doc = await readDocument(companyId, side, input.invoiceId);
  // One reply for "absent" and "another tenant's": the read is company-scoped,
  // and a distinct message would be an existence oracle.
  if (!doc) throw new CreditNoteApplyRefusal('Invoice not found.');
  const invoiceNumber = String(doc.invoice_number);
  if (String(doc.owner_id) !== counterpartyOf(note, side)) {
    throw new CreditNoteApplyRefusal(
      `Invoice ${invoiceNumber} belongs to a different ${side} than credit note ${number}.`,
    );
  }
  // An ALLOW-list, the set the FIFO walk and every cash path use (K-063):
  // pending_approval and disputed bills never credited AP, so crediting one
  // leaves the subledger apart from the GL. 'paid' is in the set because a
  // balance can reach it; it has nothing left to take.
  const docStatus = String(doc.status);
  if (!FIFO_ELIGIBLE_STATUSES.includes(docStatus) || docStatus === 'paid') {
    throw new CreditNoteApplyRefusal(
      `Invoice ${invoiceNumber} is ${docStatus} — only an approved, unpaid document can take credit.`,
    );
  }
  const outstanding = Math.max(0, round2(Number(doc.outstanding)));
  if (outstanding <= EPS) {
    throw new CreditNoteApplyRefusal(`Invoice ${invoiceNumber} has nothing outstanding.`);
  }

  // The allocation table is UNIQUE (credit_note_id, invoice_id): a second pass
  // over the pair would raise 23505 mid-write. Refused here, by name.
  const prior = (await sql`
    SELECT amount_allocated FROM credit_note_allocations
    WHERE credit_note_id = ${input.creditNoteId}::UUID AND invoice_id = ${input.invoiceId}::UUID
      AND company_id = ${companyId}::UUID`) as DbRow[];
  if (prior.length > 0) {
    throw new CreditNoteApplyRefusal(
      `Credit note ${number} is already applied to invoice ${invoiceNumber} `
      + `(R${round2(Number(prior[0]!.amount_allocated)).toFixed(2)}); a note applies to a document once.`,
    );
  }

  // Read-only: the column and the rows must agree before this extends them; and
  // (FX PR0) neither a foreign note nor a foreign document can be settled.
  try {
    await assertAllocationsMatchApplied(companyId, input.creditNoteId, appliedBefore);
    await assertStoredDocumentSettleable(companyId, 'credit_note', input.creditNoteId);
    await assertStoredDocumentSettleable(companyId, side === 'customer' ? 'customer_invoice' : 'supplier_invoice', input.invoiceId);
  } catch (err) {
    throw new CreditNoteApplyRefusal(err instanceof Error ? err.message : String(err));
  }

  const amount = round2(Math.min(input.amount ?? remainder, remainder, outstanding));
  // The engine writes only lines ABOVE a cent. A plan below that would promise
  // what the live call then cannot do.
  if (amount <= EPS) {
    throw new CreditNoteApplyRefusal(`The smallest amount that can be applied is R${(EPS + 0.01).toFixed(2)}.`);
  }
  const appliedAfter = round2(appliedBefore + amount);
  return {
    creditNoteId: input.creditNoteId,
    creditNoteNumber: number,
    side,
    invoiceId: input.invoiceId,
    invoiceNumber,
    amount,
    noteTotal: total,
    noteAppliedBefore: appliedBefore,
    noteAppliedAfter: appliedAfter,
    noteRemainderAfter: round2(total - appliedAfter),
    noteStatusAfter: deriveCreditNoteStatus(appliedAfter, total),
    invoiceOutstandingBefore: outstanding,
    invoiceOutstandingAfter: round2(outstanding - amount),
  };
}

async function readDocument(
  companyId: string,
  side: CreditNoteSide,
  invoiceId: string,
): Promise<DbRow | null> {
  const rows = (side === 'customer'
    ? await sql`
        SELECT invoice_number, status, COALESCE(client_id, customer_id) AS owner_id,
               (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM customer_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`
    : await sql`
        SELECT invoice_number, status, supplier_id AS owner_id,
               (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM supplier_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`) as DbRow[];
  return rows[0] ?? null;
}
