/**
 * Take an approved credit note's credit back off one document (or all of them)
 * WITHOUT cancelling the note.
 *
 * Cancelling reverses the note's journal and gives back every application; a
 * wrong oldest-first application needs only the application undone. This
 * moves the SUBLEDGER only, through the engine's own `undoApplication` (the
 * document's amount_paid and its recomputed status) and deletes exactly the
 * allocation rows it undid. The note keeps its journal and its unused credit
 * becomes on-account again, re-derived into applied_amount and status.
 *
 * Every refusal is decided by `buildPlan` from reads; the live path plans on
 * rows it holds (note first, then documents by id — the order cancel takes).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import { deriveCreditNoteStatus, type CreditNoteSide } from './creditNoteFifo';
import { assertAllocationsMatchApplied, lockInvoicesForUpdate, undoApplication } from './creditNoteApplicationWrites';
import { UnapplyRefusal } from './unapplyRefusal';
import type { UnapplyLine } from '../ap/supplierPaymentUnapply';

export interface CreditNoteUnapplyInput {
  creditNoteId: string;
  /** Only this document. Omitted: every document the note is applied to. */
  invoiceId?: string;
}

export interface CreditNoteUnapplyResult {
  creditNoteId: string;
  creditNoteNumber: string;
  side: CreditNoteSide;
  amountUnapplied: number;
  lines: UnapplyLine[];
  noteAppliedAfter: number;
  noteStatusAfter: string;
}

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The statuses a note can carry applications in. */
const UNAPPLIABLE_NOTE = new Set(['approved', 'partially_applied', 'applied']);

export async function planCreditNoteUnapply(
  companyId: string,
  input: CreditNoteUnapplyInput,
): Promise<CreditNoteUnapplyResult> {
  const note = ((await sql`
    SELECT * FROM credit_notes WHERE id = ${input.creditNoteId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[])[0];
  return buildPlan(companyId, note ?? null, input);
}

export async function unapplyCreditNote(
  companyId: string,
  input: CreditNoteUnapplyInput,
  userId: string,
): Promise<CreditNoteUnapplyResult> {
  const note = await lockCreditNoteForUpdate(companyId, input.creditNoteId);
  const side: CreditNoteSide = note?.type === 'supplier' ? 'supplier' : 'customer';
  const targets = (await sql`
    SELECT invoice_id FROM credit_note_allocations
    WHERE credit_note_id = ${input.creditNoteId}::UUID AND company_id = ${companyId}::UUID
      AND (${input.invoiceId ?? null}::UUID IS NULL OR invoice_id = ${input.invoiceId ?? null}::UUID)`) as DbRow[];
  await lockInvoicesForUpdate('unapplyCreditNote', companyId, side, targets.map((t) => String(t.invoice_id)));
  const plan = await buildPlan(companyId, note, input);

  for (const line of plan.lines) {
    await undoApplication(companyId, plan.creditNoteId, plan.side, { invoiceId: line.invoiceId, amount: line.amount });
    await sql`
      DELETE FROM credit_note_allocations
      WHERE credit_note_id = ${plan.creditNoteId}::UUID AND invoice_id = ${line.invoiceId}::UUID
        AND company_id = ${companyId}::UUID`;
  }
  await sql`
    UPDATE credit_notes SET applied_amount = ${plan.noteAppliedAfter}, status = ${plan.noteStatusAfter},
           updated_at = NOW()
    WHERE id = ${plan.creditNoteId}::UUID AND company_id = ${companyId}::UUID`;

  log.info('Unapplied credit note', {
    creditNoteId: plan.creditNoteId, lines: plan.lines.length, amount: plan.amountUnapplied, userId,
  }, 'accounting');
  return plan;
}

async function buildPlan(
  companyId: string,
  note: DbRow | null,
  input: CreditNoteUnapplyInput,
): Promise<CreditNoteUnapplyResult> {
  if (!note) throw new UnapplyRefusal('Not found');
  const number = String(note.credit_note_number);
  const status = String(note.status);
  if (!UNAPPLIABLE_NOTE.has(status)) {
    throw new UnapplyRefusal(`Credit note ${number} is ${status} and has no application to take back.`);
  }
  const side: CreditNoteSide = note.type === 'supplier' ? 'supplier' : 'customer';
  const total = round2(Number(note.total_amount));
  const appliedBefore = round2(Number(note.applied_amount ?? 0));

  // The rows and the column must agree, or undoing rows leaves the rest of
  // applied_amount credited to a document nothing names.
  try {
    await assertAllocationsMatchApplied(companyId, input.creditNoteId, appliedBefore);
  } catch (err) {
    throw new UnapplyRefusal(err instanceof Error ? err.message : String(err));
  }

  const rows = (side === 'customer'
    ? await sql`
        SELECT a.invoice_id, a.amount_allocated, d.invoice_number, d.status, d.total_amount,
               COALESCE(d.amount_paid, 0) AS amount_paid, d.deleted_at
        FROM credit_note_allocations a
        JOIN customer_invoices d ON d.id = a.invoice_id AND d.company_id = a.company_id
        WHERE a.credit_note_id = ${input.creditNoteId}::UUID AND a.company_id = ${companyId}::UUID
          AND (${input.invoiceId ?? null}::UUID IS NULL OR a.invoice_id = ${input.invoiceId ?? null}::UUID)
        ORDER BY a.invoice_id`
    : await sql`
        SELECT a.invoice_id, a.amount_allocated, d.invoice_number, d.status, d.total_amount,
               COALESCE(d.amount_paid, 0) AS amount_paid, d.deleted_at
        FROM credit_note_allocations a
        JOIN supplier_invoices d ON d.id = a.invoice_id AND d.company_id = a.company_id
        WHERE a.credit_note_id = ${input.creditNoteId}::UUID AND a.company_id = ${companyId}::UUID
          AND (${input.invoiceId ?? null}::UUID IS NULL OR a.invoice_id = ${input.invoiceId ?? null}::UUID)
        ORDER BY a.invoice_id`) as DbRow[];
  if (rows.length === 0) {
    throw new UnapplyRefusal(
      input.invoiceId
        ? `Credit note ${number} is not applied to that document.`
        : `Credit note ${number} is not applied to any document.`,
    );
  }

  const lines: UnapplyLine[] = [];
  for (const r of rows) {
    const docNumber = String(r.invoice_number);
    const amount = round2(Number(r.amount_allocated));
    const paid = round2(Number(r.amount_paid));
    // Soft-deleted: its journal is reversed, so its balance is not the ledger's.
    // lockInvoicesForUpdate would also have left it unlocked.
    if (r.deleted_at != null) {
      throw new UnapplyRefusal(
        `Document ${docNumber} has been deleted; credit note ${number}'s application to it cannot be taken `
        + 'back here. Reconcile it by hand.',
      );
    }
    if (!FIFO_ELIGIBLE_STATUSES.includes(String(r.status))) {
      throw new UnapplyRefusal(
        `Document ${docNumber} is ${String(r.status)}; credit note ${number}'s application to it cannot be `
        + 'taken back here. Reconcile it by hand.',
      );
    }
    if (paid + EPS < amount) {
      throw new UnapplyRefusal(
        `Document ${docNumber} shows R${paid.toFixed(2)} settled, less than the R${amount.toFixed(2)} credit note `
        + `${number} applied — its balance and the allocation disagree. Reconcile it by hand.`,
      );
    }
    const before = round2(Number(r.total_amount) - paid);
    lines.push({ invoiceId: String(r.invoice_id), invoiceNumber: docNumber, amount, outstandingBefore: before, outstandingAfter: round2(before + amount) });
  }

  const amountUnapplied = round2(lines.reduce((s, l) => s + l.amount, 0));
  const appliedAfter = round2(appliedBefore - amountUnapplied);
  return {
    creditNoteId: input.creditNoteId,
    creditNoteNumber: number,
    side,
    amountUnapplied,
    lines,
    noteAppliedAfter: appliedAfter,
    noteStatusAfter: deriveCreditNoteStatus(appliedAfter, total),
  };
}
