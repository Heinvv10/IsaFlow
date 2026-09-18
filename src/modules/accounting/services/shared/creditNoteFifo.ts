/**
 * Applying a credit note to the documents it is meant to settle, oldest first.
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────
 *
 * Approving a credit note applied it to ONE invoice — the one named on the note
 * — and only if a link had been set at create time. Everything else stayed on
 * the note as a number nothing consumed: a note larger than its invoice was
 * capped at that invoice's outstanding balance and the excess was stranded
 * (a note at 'applied' cannot be applied again), and a note with no link at all
 * applied nothing while the customer's or supplier's oldest documents went on
 * aging. The cash side of the ledger has done oldest-first application since
 * migration 614; credit did not.
 *
 * ── WHAT HAPPENS NOW ────────────────────────────────────────────────────────
 *
 * A linked note still settles its own document first and is still capped at
 * that document's outstanding balance — the link is an instruction and it is
 * honoured before anything is guessed. The REMAINDER then walks the same
 * entity's other open documents oldest first, settling each in full until the
 * credit runs out and partly settling the one it runs out on. What is left when
 * there is nothing open stays on the note as on-account credit, visible through
 * `getUnappliedCreditNotes` and netted by the aged reports.
 *
 * `auto_apply: 'none'` turns the walk off and keeps the old behaviour: the
 * linked document only, or nothing at all.
 *
 * ── WHY THE ROWS, NOT THE COLUMN ────────────────────────────────────────────
 *
 * `credit_notes.applied_amount` cannot describe a note spread over three bills,
 * and a cancel that reads a single column cannot know which balances to give
 * back. Every application writes a `credit_note_allocations` row (migration
 * 677) and `applied_amount` becomes the SUM of those rows. The table's UNIQUE
 * (credit_note_id, invoice_id) is what makes a second pass over the same pair
 * raise 23505 rather than double-credit the document.
 *
 * ── WHY IT REUSES THE CASH FETCHERS ─────────────────────────────────────────
 *
 * `fetchOpenSupplierBills` / `fetchOpenCustomerInvoices` already define what
 * "open" means for automatic application — the status sets, the cent tolerance,
 * the `COALESCE(client_id, customer_id)` join. A second definition here would
 * drift, and then credit and cash would disagree about which bill is next.
 *
 * NOTHING IS CAUGHT. Every write below runs inside the approval's transaction,
 * after its journal has posted. A throw unwinds the journal with it, which is
 * the correct outcome; catching would commit a half-applied note.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fetchOpenSupplierBills } from '../ap/supplierAutoAllocate';
import { fetchOpenCustomerInvoices } from '../ar/customerAutoAllocate';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { EPS, planGreedyAllocations, round2 } from './autoAllocateStrategy';

export const CREDIT_NOTE_AUTO_APPLY = ['fifo', 'none'] as const;
export type CreditNoteAutoApply = (typeof CREDIT_NOTE_AUTO_APPLY)[number];
export type CreditNoteSide = 'customer' | 'supplier';

/** A value from a request or a tool argument, or null when it is neither. */
export function parseCreditNoteAutoApply(value: unknown): CreditNoteAutoApply | null {
  return typeof value === 'string' && (CREDIT_NOTE_AUTO_APPLY as readonly string[]).includes(value)
    ? value as CreditNoteAutoApply
    : null;
}

/**
 * The status a note is IN, derived from what it consumed — never written by
 * hand. Compared at a cent like every other money test in this codebase: a note
 * that consumed 114.995 of 115 is settled, not partly settled.
 */
export function deriveCreditNoteStatus(
  appliedAmount: number,
  totalAmount: number,
): 'approved' | 'partially_applied' | 'applied' {
  if (appliedAmount <= EPS) return 'approved';
  if (appliedAmount >= round2(totalAmount) - EPS) return 'applied';
  return 'partially_applied';
}

export interface CreditNoteApplicationLine {
  invoiceId: string;
  amount: number;
}

export interface CreditNoteApplication {
  /** Sum of the lines, and what `credit_notes.applied_amount` must be set to. */
  appliedAmount: number;
  lines: CreditNoteApplicationLine[];
  /** Face value not consumed by any document — on-account credit. */
  remainder: number;
}

async function readOutstanding(
  companyId: string,
  side: CreditNoteSide,
  invoiceId: string,
): Promise<number | null> {
  const rows = (side === 'customer'
    ? await sql`
        SELECT total_amount, amount_paid FROM customer_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`
    : await sql`
        SELECT total_amount, amount_paid FROM supplier_invoices
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  return Math.max(0, round2(Number(row.total_amount) - Number(row.amount_paid ?? 0)));
}

/**
 * Write ONE application: the allocation row, the document's `amount_paid`, and
 * the status recompute — in that order, so a failed money write leaves no row
 * claiming the money moved.
 *
 * `recomputeInvoiceStatus` owns the status and `paid_at`; nothing here writes
 * either by hand.
 */
async function writeApplication(
  companyId: string,
  creditNoteId: string,
  side: CreditNoteSide,
  line: CreditNoteApplicationLine,
): Promise<void> {
  await sql`
    INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
    VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${line.invoiceId}::UUID, ${line.amount})
  `;
  const applied = (side === 'customer'
    ? await sql`
        UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
        RETURNING id`
    : await sql`
        UPDATE supplier_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
        RETURNING id`) as DbRow[];
  // A row count of zero means the document vanished between the read and the
  // write. Refusing beats an allocation row pointing at nothing.
  if (applied.length !== 1) {
    throw new Error(
      `Credit note ${creditNoteId}: applying ${line.amount} to invoice ${line.invoiceId} wrote no row.`,
    );
  }
  await recomputeInvoiceStatus(companyId, side, line.invoiceId);
}

/**
 * Apply a credit note: its linked document first, then the entity's other open
 * documents oldest first when `autoApply` is 'fifo'.
 *
 * Throws when the linked document no longer exists — the link was validated at
 * create time, so a miss means it was deleted afterwards, and reporting an
 * application that never happened is the outcome this refuses.
 */
export async function applyCreditNote(args: {
  companyId: string;
  creditNoteId: string;
  side: CreditNoteSide;
  /** The customer or supplier the note belongs to; null skips the FIFO walk. */
  entityId: string | null;
  totalAmount: number;
  linkedInvoiceId: string | null;
  autoApply: CreditNoteAutoApply;
}): Promise<CreditNoteApplication> {
  const { companyId, creditNoteId, side, entityId, linkedInvoiceId, autoApply } = args;
  const totalAmount = round2(args.totalAmount);
  const lines: CreditNoteApplicationLine[] = [];
  let consumed = 0;

  if (linkedInvoiceId) {
    const outstanding = await readOutstanding(companyId, side, linkedInvoiceId);
    if (outstanding === null) {
      throw new Error(
        `Credit note ${creditNoteId} is linked to invoice ${linkedInvoiceId}, which no longer exists in this company.`,
      );
    }
    const amount = round2(Math.min(totalAmount, outstanding));
    if (amount > EPS) {
      lines.push({ invoiceId: linkedInvoiceId, amount });
      consumed = amount;
    }
  }

  const remaining = round2(totalAmount - consumed);
  if (autoApply === 'fifo' && entityId && remaining > EPS) {
    const open = side === 'customer'
      ? await fetchOpenCustomerInvoices(companyId, entityId, true)
      : await fetchOpenSupplierBills(companyId, entityId, true);
    // The linked document is dropped from the walk rather than re-read: it has
    // just been settled as far as this note can settle it, and a second line
    // for the same pair would violate the allocation table's UNIQUE.
    const rest = open.filter((d) => d.invoiceId !== linkedInvoiceId);
    for (const planned of planGreedyAllocations(remaining, rest)) {
      lines.push({ invoiceId: planned.invoiceId, amount: planned.amount });
      consumed = round2(consumed + planned.amount);
    }
  }

  for (const line of lines) {
    await writeApplication(companyId, creditNoteId, side, line);
  }

  return {
    appliedAmount: round2(consumed),
    lines,
    remainder: round2(totalAmount - consumed),
  };
}

/**
 * The documents a note has been applied to.
 *
 * NOT in application order, and it cannot be: every application in one approval
 * shares a transaction, and `created_at DEFAULT NOW()` is the TRANSACTION
 * timestamp, so all the rows carry the same instant. The order below is that
 * timestamp then the invoice id — stable and deterministic, which is what a
 * caller rendering a list needs. Which document was settled first is recoverable
 * from the documents' own dates, since the walk is oldest-first by construction.
 */
export async function listCreditNoteAllocations(
  companyId: string,
  creditNoteId: string,
): Promise<CreditNoteApplicationLine[]> {
  const rows = (await sql`
    SELECT invoice_id, amount_allocated
    FROM credit_note_allocations
    WHERE credit_note_id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY created_at ASC, invoice_id ASC
  `) as DbRow[];
  return rows.map((r) => ({
    invoiceId: String(r.invoice_id),
    amount: Number(r.amount_allocated),
  }));
}

/**
 * Give back everything a note applied, and delete the rows that recorded it.
 *
 * Returns the documents restored. A note approved before migration 677 has no
 * rows, so the caller falls back to its single link — see creditNoteCancelService.
 */
export async function reverseCreditNoteApplications(
  companyId: string,
  creditNoteId: string,
  side: CreditNoteSide,
): Promise<CreditNoteApplicationLine[]> {
  const lines = await listCreditNoteAllocations(companyId, creditNoteId);

  for (const line of lines) {
    // `amount_paid >= X` rather than GREATEST(0, ...): flooring at zero
    // silently absorbs exactly the corruption worth hearing about.
    const done = (side === 'customer'
      ? await sql`
          UPDATE customer_invoices SET amount_paid = amount_paid - ${line.amount}
          WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
            AND amount_paid >= ${line.amount}
          RETURNING id`
      : await sql`
          UPDATE supplier_invoices SET amount_paid = amount_paid - ${line.amount}
          WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
            AND amount_paid >= ${line.amount}
          RETURNING id`) as DbRow[];
    if (done.length === 0) {
      throw new Error(
        `Cannot cancel credit note ${creditNoteId}: invoice ${line.invoiceId} has less applied than the ${line.amount} this note credited.`,
      );
    }
    await recomputeInvoiceStatus(companyId, side, line.invoiceId);
  }

  await sql`
    DELETE FROM credit_note_allocations
    WHERE credit_note_id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
  `;
  return lines;
}

/**
 * On-account credit, re-exported from the module that owns the aged-report
 * reads. It lives there because it is a REPORTING question — what credit is
 * still available — and this module is the write path; it is re-exported here
 * because callers reach for the credit-note module first.
 */
export { getUnappliedCreditNotes } from './agedNetting';
export type { UnappliedCreditNotesSummary } from './agedNetting';
