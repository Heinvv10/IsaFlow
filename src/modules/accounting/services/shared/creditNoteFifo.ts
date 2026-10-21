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
 * `auto_apply: 'none'` turns the walk off: the linked document only.
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
import { log } from '@/lib/logger';
import { fetchOpenSupplierBills } from '../ap/supplierAutoAllocate';
import { fetchOpenCustomerInvoices } from '../ar/customerAutoAllocate';
import { EPS, invoiceFloor, planGreedyAllocations, round2 } from './autoAllocateStrategy';
import {
  UNAPPLICABLE_STATUSES, assertAllocationsMatchApplied, lockInvoicesForUpdate,
  undoApplication, writeApplication,
} from './creditNoteApplicationWrites';

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
  // A note that consumed a whole cent is not 'approved'.
  if (round2(appliedAmount) <= 0) return 'approved';
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
  /**
   * What this note has consumed ALREADY, per `credit_notes.applied_amount`.
   * Approval passes 0. It is checked against the allocation rows before
   * anything is written — see `assertAllocationsMatchApplied`.
   */
  alreadyApplied?: number;
}): Promise<CreditNoteApplication> {
  const { companyId, creditNoteId, side, entityId, linkedInvoiceId, autoApply } = args;
  const totalAmount = round2(args.totalAmount);

  // The column and the rows must already agree, or this application extends a
  // figure nobody can reconstruct — see the function's own comment.
  await assertAllocationsMatchApplied(companyId, creditNoteId, args.alreadyApplied ?? 0);

  // ── 1. WHICH documents could take this credit, in the order they should ────
  //
  // Unlocked, and deliberately: this only establishes the CANDIDATE set and the
  // FIFO order. Every figure it returns is discarded — an invoice settled by a
  // concurrent request between here and the lock below must not be planned
  // against its stale balance.
  //
  // `{ forUpdate: false }` says that out loud. The L1 branch made the option
  // required precisely because the two callers of these fetchers want opposite
  // answers, and a default would have silently given one of them the wrong one
  // — which for this call would mean taking every candidate row's lock twice,
  // once here and once in lockInvoicesForUpdate below.
  const candidates: string[] = [];
  if (linkedInvoiceId) candidates.push(linkedInvoiceId);
  if (autoApply === 'fifo' && entityId) {
    const open = side === 'customer'
      ? await fetchOpenCustomerInvoices(companyId, entityId, true, { forUpdate: false })
      : await fetchOpenSupplierBills(companyId, entityId, true, { forUpdate: false });
    for (const doc of open) {
      // The linked document is already first in the list. A second entry would
      // plan against it twice and violate the allocation table's UNIQUE.
      if (doc.invoiceId !== linkedInvoiceId) candidates.push(doc.invoiceId);
    }
  }

  // ── 2. LOCK them, and take the balances as locked ─────────────────────────
  const locked = await lockInvoicesForUpdate('applyCreditNote', companyId, side, candidates);

  if (linkedInvoiceId && !locked.has(linkedInvoiceId)) {
    // The link was validated at create time, so a miss means the document was
    // deleted afterwards. Refusing beats reporting an application that never
    // happened.
    throw new Error(
      `Credit note ${creditNoteId} is linked to invoice ${linkedInvoiceId}, which no longer exists in this company.`,
    );
  }

  // ── 3. PLAN against the locked figures ────────────────────────────────────
  const lines: CreditNoteApplicationLine[] = [];
  let consumed = 0;

  if (linkedInvoiceId) {
    // The link is an instruction, not a licence. It was validated when the note
    // was created (creditNoteLinkService), but a document can be cancelled or
    // taken back to draft between then and approval — and crediting one that has
    // posted nothing reduces a balance the ledger does not carry.
    //
    // SKIPPED, not refused. The note is a real credit either way, and refusing
    // the whole approval over a document somebody else withdrew would strand it
    // as a draft. So the walk takes the money to this entity's open documents
    // instead, and whatever is left stays on account — both visible, both
    // reversible, neither silent.
    const linked = locked.get(linkedInvoiceId)!;
    const linkedIsApplicable = !UNAPPLICABLE_STATUSES[side].includes(linked.status);
    const amount = linkedIsApplicable
      ? round2(Math.min(totalAmount, linked.outstanding))
      : 0;
    if (amount > invoiceFloor(side)) {
      lines.push({ invoiceId: linkedInvoiceId, amount });
      consumed = amount;
    } else if (!linkedIsApplicable) {
      // A SETTLED linked document is routine — a credit note raised after the
      // invoice was paid is an ordinary return — and the old capping path
      // applied nothing to it either. Anything else means the document was
      // withdrawn after the link was validated, which is worth a line in the
      // log at info.
      const routine = linked.status === 'paid';
      const entry = {
        creditNoteId, linkedInvoiceId, status: linked.status,
      };
      if (routine) log.debug('Credit note skipped its settled linked document', entry, 'accounting');
      else log.info('Credit note skipped its linked document', entry, 'accounting');
    }
  }

  const remaining = round2(totalAmount - consumed);
  if (remaining > EPS) {
    const rest = candidates
      .filter((id) => id !== linkedInvoiceId && locked.has(id))
      .map((id) => ({ invoiceId: id, outstanding: locked.get(id)!.outstanding }));
    for (const planned of planGreedyAllocations(remaining, rest, invoiceFloor(side))) {
      lines.push({ invoiceId: planned.invoiceId, amount: planned.amount });
      consumed = round2(consumed + planned.amount);
    }
  }

  // ── 4. WRITE ──────────────────────────────────────────────────────────────
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
  /** `credit_notes.applied_amount`, checked against the rows before anything moves. */
  appliedAmount: number,
): Promise<CreditNoteApplicationLine[]> {
  const lines = await listCreditNoteAllocations(companyId, creditNoteId);
  if (lines.length === 0) return lines;

  // Refuses a note whose column and rows disagree — restoring only the rows
  // would leave the rest of `applied_amount` credited to a document nothing
  // names. Same guard, same reasoning, as on the way in.
  await assertAllocationsMatchApplied(companyId, creditNoteId, appliedAmount);

  // Locked in id order, in ONE statement, exactly as the apply path takes them.
  await lockInvoicesForUpdate('cancelCreditNote', companyId, side, lines.map((l) => l.invoiceId));

  for (const line of lines) {
    await undoApplication(companyId, creditNoteId, side, line);
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
export { assertAllocationsMatchApplied } from './creditNoteApplicationWrites';
export { getUnappliedCreditNotes } from './agedNetting';
export type { UnappliedCreditNotesSummary } from './agedNetting';
