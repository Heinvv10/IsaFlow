/**
 * Change how much of an approved credit note is applied to ONE document.
 *
 * `apply_credit_note` puts credit on a document the note has not touched, and
 * `unapply_credit_note` takes a whole application back. Neither can say "R40 of
 * this note belongs on that invoice, not R100" — the agent had to unapply and
 * re-apply, and the re-apply is where CN-388 counted a cent the ledger never
 * carried. This sets the application to an exact figure: 0 takes it all back,
 * less takes part back, more applies more.
 *
 * Posts NO journal, exactly like the two it extends: the note's approval
 * journal already moved the control account, and an application moves only the
 * subledger. It writes through the engine's own row writers — `undoApplication`
 * gives the document back what this note applied to it and the allocation row
 * goes; `writeApplication` writes the new figure (row, `amount_paid`, status
 * recompute) — so `cancel_credit_note` and `unapply_credit_note` reverse what it
 * leaves like anything the approval wrote.
 *
 * An increase is bounded THREE ways and never silently capped (the caller named
 * an exact amount): the note's unapplied credit, the document's outstanding
 * balance, and what the note's journal POSTED (`creditNotePostedCredit`). Every
 * refusal is decided from reads by `buildPlan`, which the dry run runs as is;
 * the live call plans on rows it holds (note first, then the document — the
 * order approve, apply, unapply and cancel take) and checks the posted-credit
 * invariant before the note records the new figure.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { formatMoney } from '@/lib/money/formatMoney';
import { hasWholeCents } from '@/lib/money/wholeCents';
import { lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import { invoiceFloor, round2 } from './autoAllocateStrategy';
import { deriveCreditNoteStatus, type CreditNoteSide } from './creditNoteFifo';
import {
  assertAllocationsMatchApplied, lockInvoicesForUpdate, undoApplication, writeApplication,
} from './creditNoteApplicationWrites';
import { assertStoredDocumentSettleable } from './documentCurrency';
import { readCreditNoteDocument } from './creditNoteDocumentRead';
import { assertApplicationWithinPostedCredit, postedCreditRefusal, readPostedCreditOrRefuse } from './creditNotePostedCredit';
import { assertApplicationRecorded } from './creditNoteApplicationInvariant';

/** A refusal decided from reads, before any write. Its message names no schema. */
export class CreditNoteAdjustRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditNoteAdjustRefusal';
  }
}

export interface CreditNoteAdjustInput {
  creditNoteId: string;
  documentId: string;
  /** What this note should have applied to the document afterwards. 0 = none. Whole cents. */
  newAmount: number;
}

export interface CreditNoteAdjustResult {
  creditNoteId: string;
  creditNoteNumber: string;
  side: CreditNoteSide;
  /** The journal that carries the note's credit. An adjustment posts none of its own. */
  creditNoteJournalId: string;
  documentId: string;
  documentNumber: string;
  /** What the note had applied to this document, and has after. */
  appliedBefore: number;
  appliedAfter: number;
  change: number;
  documentOutstandingBefore: number;
  documentOutstandingAfter: number;
  noteTotal: number;
  notePosted: number;
  noteAppliedBefore: number;
  noteAppliedAfter: number;
  noteRemainderAfter: number;
  noteStatusAfter: string;
}

/** The statuses a note can carry applications in. A draft has none; a cancelled note gave them back. */
const ADJUSTABLE_NOTE = new Set(['approved', 'partially_applied', 'applied']);
const HALF_CENT = 0.005;

/** Every guard, from reads alone. The dry run returns this. */
export async function planCreditNoteApplicationAdjust(
  companyId: string,
  input: CreditNoteAdjustInput,
): Promise<CreditNoteAdjustResult> {
  const rows = (await sql`
    SELECT * FROM credit_notes
    WHERE id = ${input.creditNoteId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return buildPlan(companyId, rows[0] ?? null, input);
}

export async function adjustCreditNoteApplication(
  companyId: string,
  input: CreditNoteAdjustInput,
  userId: string,
): Promise<CreditNoteAdjustResult> {
  const note = await lockCreditNoteForUpdate(companyId, input.creditNoteId);
  // Note-only refusals before the document's lock: a call against a draft or
  // cancelled note must not hold a row lock on a document it will not touch.
  const side = checkNote(note, input).side;
  await lockInvoicesForUpdate('adjustCreditNoteApplication', companyId, side, [input.documentId]);
  const plan = await buildPlan(companyId, note, input);

  const line = { invoiceId: plan.documentId };
  let paidMoved = 0;
  if (plan.appliedBefore > 0) {
    paidMoved += await undoApplication(companyId, plan.creditNoteId, side, { ...line, amount: plan.appliedBefore });
    await sql`
      DELETE FROM credit_note_allocations
      WHERE credit_note_id = ${plan.creditNoteId}::UUID AND invoice_id = ${plan.documentId}::UUID
        AND company_id = ${companyId}::UUID`;
  }
  if (plan.appliedAfter > 0) {
    paidMoved += await writeApplication(companyId, plan.creditNoteId, side, { ...line, amount: plan.appliedAfter });
  }
  // The invariants. Thrown, never refused: the document has already moved, so the registry must unwind it.
  await assertApplicationWithinPostedCredit(companyId, note!, side, plan.noteAppliedBefore, plan.noteAppliedAfter);
  await sql`
    UPDATE credit_notes SET applied_amount = ${plan.noteAppliedAfter}, status = ${plan.noteStatusAfter},
           updated_at = NOW()
    WHERE id = ${plan.creditNoteId}::UUID AND company_id = ${companyId}::UUID`;
  await assertApplicationRecorded(companyId, plan.creditNoteId, plan.creditNoteNumber,
    { rowsMoved: plan.change, paidMoved, appliedAfter: plan.noteAppliedAfter });

  log.info('Adjusted a credit note application', {
    creditNoteId: plan.creditNoteId, documentId: plan.documentId,
    from: plan.appliedBefore, to: plan.appliedAfter, noteAppliedAfter: plan.noteAppliedAfter, userId,
  }, 'accounting');
  return plan;
}

function checkNote(note: DbRow | null, input: CreditNoteAdjustInput): { note: DbRow; side: CreditNoteSide } {
  if (!note) throw new CreditNoteAdjustRefusal('Credit note not found.');
  const number = String(note.credit_note_number);
  const status = String(note.status);
  if (status === 'draft') {
    throw new CreditNoteAdjustRefusal(
      `Credit note ${number} is a draft — approve it with approve_credit_note first; a draft has no applications.`,
    );
  }
  if (!ADJUSTABLE_NOTE.has(status)) {
    throw new CreditNoteAdjustRefusal(`Credit note ${number} is ${status}; its applications cannot be adjusted.`);
  }
  const n = input.newAmount;
  if (n < 0 || !hasWholeCents(n)) {
    throw new CreditNoteAdjustRefusal('new_amount must be zero or a positive amount in whole cents.');
  }
  return { note, side: note.type === 'supplier' ? 'supplier' : 'customer' };
}

async function buildPlan(
  companyId: string,
  noteRow: DbRow | null,
  input: CreditNoteAdjustInput,
): Promise<CreditNoteAdjustResult> {
  const { note, side } = checkNote(noteRow, input);
  const number = String(note.credit_note_number);
  const total = round2(Number(note.total_amount));
  const noteAppliedBefore = round2(Number(note.applied_amount ?? 0));

  const doc = await readCreditNoteDocument(companyId, side, input.documentId);
  // One reply for absent and another tenant's: the read is company-scoped.
  if (!doc) throw new CreditNoteAdjustRefusal('Document not found.');
  const docNumber = String(doc.invoice_number);
  const party = side === 'customer' ? note.client_id : note.supplier_id;
  if (String(doc.owner_id) !== String(party)) {
    throw new CreditNoteAdjustRefusal(`Document ${docNumber} belongs to a different ${side} than credit note ${number}.`);
  }

  // Outside the catch below: a reversal-lock timeout is retryable and must reach the registry as itself.
  const { journalId, posted } = await readPostedCreditOrRefuse(companyId, note, side, (m) => new CreditNoteAdjustRefusal(m));
  const prior = (await sql`
    SELECT amount_allocated FROM credit_note_allocations
    WHERE credit_note_id = ${input.creditNoteId}::UUID AND invoice_id = ${input.documentId}::UUID
      AND company_id = ${companyId}::UUID`) as DbRow[];
  const appliedBefore = prior.length > 0 ? round2(Number(prior[0]!.amount_allocated)) : 0;
  const appliedAfter = round2(input.newAmount);
  const change = round2(appliedAfter - appliedBefore);

  // Rows vs column: EXACT to raise what is applied, a cent of tolerance to lower it — so a note already a cent
  // apart is refused more credit by name but can always be brought down (to 0), and its figure after is re-derived
  // from the rows (`rowsBefore + change`), which is what puts it back in line.
  let rowsBefore: number;
  try {
    rowsBefore = await assertAllocationsMatchApplied(
      companyId, input.creditNoteId, noteAppliedBefore, change > 0 ? 'increase' : 'decrease');
    await assertStoredDocumentSettleable(companyId, 'credit_note', input.creditNoteId);
    await assertStoredDocumentSettleable(companyId, side === 'customer' ? 'customer_invoice' : 'supplier_invoice', input.documentId);
  } catch (err) {
    throw new CreditNoteAdjustRefusal(err instanceof Error ? err.message : String(err));
  }
  if (Math.abs(change) < HALF_CENT) {
    throw new CreditNoteAdjustRefusal(
      `Credit note ${number} already has ${formatMoney(appliedBefore)} applied to document ${docNumber}; nothing to change.`,
    );
  }

  // A balance-derived document only, as apply and unapply require: any other
  // status never moved the control account, or is closed to settlement.
  const docStatus = String(doc.status);
  if (!FIFO_ELIGIBLE_STATUSES.includes(docStatus)) {
    throw new CreditNoteAdjustRefusal(
      `Document ${docNumber} is ${docStatus}; credit note ${number}'s application to it cannot be adjusted here.`,
    );
  }
  const paid = round2(Number(doc.amount_paid));
  if (appliedBefore > 0 && paid + HALF_CENT < appliedBefore) {
    throw new CreditNoteAdjustRefusal(
      `Document ${docNumber} shows ${formatMoney(paid)} settled, less than the ${formatMoney(appliedBefore)} credit note ${number} `
      + 'applied to it; its balance and the allocation disagree. Reconcile it by hand.',
    );
  }
  if (appliedAfter > 0 && appliedAfter <= invoiceFloor(side)) {
    throw new CreditNoteAdjustRefusal(
      `The smallest amount that can stay applied is ${formatMoney(invoiceFloor(side) + 0.01)}; pass 0 to take it all back.`,
    );
  }

  const outstanding = Math.max(0, round2(Number(doc.outstanding)));
  if (change > 0) {
    const remainder = round2(total - noteAppliedBefore);
    const postedLeft = round2(posted - noteAppliedBefore);
    if (change > remainder + HALF_CENT) {
      throw new CreditNoteAdjustRefusal(
        `Credit note ${number} has only ${formatMoney(Math.max(0, remainder))} unapplied; ${formatMoney(change)} more cannot be applied.`,
      );
    }
    // The rule: a write never takes applied above max(posted, applied before) — so a decrease is always
    // allowed (it is never checked here), and an increase on a note already past its posted credit is refused.
    if (change > postedLeft + HALF_CENT) {
      throw new CreditNoteAdjustRefusal(postedCreditRefusal(number, posted, noteAppliedBefore, total, change));
    }
    if (change > outstanding + HALF_CENT) {
      throw new CreditNoteAdjustRefusal(
        `Document ${docNumber} has only ${formatMoney(outstanding)} outstanding; ${formatMoney(change)} more cannot be applied.`,
      );
    }
  }

  const noteAppliedAfter = round2(rowsBefore + change);
  return {
    creditNoteId: input.creditNoteId,
    creditNoteNumber: number,
    side,
    creditNoteJournalId: journalId,
    documentId: input.documentId,
    documentNumber: docNumber,
    appliedBefore,
    appliedAfter,
    change,
    documentOutstandingBefore: outstanding,
    documentOutstandingAfter: round2(outstanding - change),
    noteTotal: total,
    notePosted: posted,
    noteAppliedBefore,
    noteAppliedAfter,
    noteRemainderAfter: round2(total - noteAppliedAfter),
    noteStatusAfter: deriveCreditNoteStatus(noteAppliedAfter, total, side),
  };
}
