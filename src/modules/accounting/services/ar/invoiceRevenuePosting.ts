/**
 * What `postCustomerInvoiceToGL` and `approveCreditNote` read to build their
 * revenue legs — the invoice's checked stored lines, and a note's share of the
 * invoice journal's revenue legs. The allocation is pure
 * (`invoiceRevenueLines.ts`, `invoiceVatLegs.ts`); this file reads what it
 * allocates.
 */
import { sql } from '@/lib/neon';
import { creditNoteHeaderOf } from './creditNoteHeaderTags';
import type { JournalLineInput } from '../../types/gl.types';
import { InvoiceLineCodingRefusal } from './invoiceLineCoding';
import { assertPostsStoredDimensions } from '../gl/dimensions/dimensionStoredPosting';
import { storedInvoiceLines, storedLinesRefusal } from './invoiceLineCodingGuard';
import {
  allocateCreditNote, isRevenueCoded, remainingCarries, type CreditNoteAllocation, type LegTags, type RevenueLeg,
} from './invoiceRevenueLines';
import type { StoredVatLine } from './invoiceVatLegs';
import { allocateTypedCreditNote, legsAreTyped, settleApplied } from './creditNoteTypedSplit';
import { NO_NOTE, invoiceRevenueLegs, invoiceVatLeft, legacyLinkedNotes } from './invoiceCreditBasisRead';
import { detachedAppliedOn } from './creditNoteDetachedRead';

/**
 * The invoice's stored lines (with their VAT, migration 1008), held to every
 * rule posting must meet before its journal is created. The caller builds the
 * credit legs from them: buildInvoiceRevenueLines for a legacy invoice (an
 * invoice with no coded line gets the single default_revenue leg it always
 * got), invoiceVatLegs for one whose lines carry their VAT type. `status` is
 * the one the invoice is posted FROM: approving (draft, pending_approval)
 * refuses a line its customer's or project's FNO would add to, or a dimension
 * no longer an active master; past draft it posts as stored (#675).
 */
export async function postableInvoiceLines(
  companyId: string,
  invoiceId: string,
  invoiceNumber: string,
  status: string,
): Promise<StoredVatLine[]> {
  const stored = await storedInvoiceLines(companyId, invoiceId);
  const lines = stored?.lines ?? [];
  await assertPostsStoredDimensions(companyId, status, lines,
    (i) => `Invoice ${invoiceNumber} line ${i + 1}`, stored?.customerFnoId ?? null);
  if (lines.some(isRevenueCoded)) {
    // Under lock, against the chart as it is now — approve already refused
    // this before its first write; Post to GL and the backfills meet it here,
    // before the journal is created.
    const refusal = await storedLinesRefusal(companyId, stored);
    if (refusal) throw new InvoiceLineCodingRefusal(refusal);
  }
  return lines;
}

/**
 * A customer credit note's revenue debit, and the allocation rows the caller
 * records with it (recordCreditNoteRevenueAllocations).
 *
 * Linked to an invoice that carries a journal: pro rata over that journal's
 * revenue legs (each line on a revenue-type account is one leg, at its CURRENT
 * account and tags: an account merge or a dimension re-tag moves the line in
 * place), each capped at what it still carries — its net, less what the live
 * (approved, not cancelled) earlier notes on the invoice TOOK from that line,
 * as their credit_note_revenue_allocations rows record it. A cancelled note's
 * rows stop counting, so its share is available again. A note approved before
 * migration 874 has no rows; its take is REPLAYED from its amount in approval
 * order — the fallback for those notes only (a note unlinked at approval and
 * applied later records an excess row then, so it is never replayed). The excess posts untagged to default_revenue. A leg
 * whose account has since been deactivated is debited on default_revenue,
 * keeping its tags. A linked note's own header tags never post: the invoice's
 * legs decide (creditNoteHeaderTags refuses them on a linked note).
 *
 * Unlinked: one default_revenue debit carrying the note's header tags (`tags`).
 *
 * Called with the invoice's credit-note lock held
 * (creditNotePostingChecks.lockInvoiceCreditNotes), so no other approval of a
 * note on this invoice can run between these reads and this note's rows.
 */
export async function creditNoteRevenueJournalLines(
  companyId: string,
  note: {
    id: string; number: string; amount: number; customerInvoiceId: string | null; tags: LegTags;
    /** The note's VAT: against a TYPED invoice it must be the invoice's remaining VAT in proportion (creditNoteTypedSplit). */
    taxAmount: number;
  },
  defaultRevenueAccountId: string,
): Promise<{ lines: JournalLineInput[]; allocations: CreditNoteAllocation[] }> {
  if (!note.customerInvoiceId) {
    const { lines } = allocateCreditNote(
      [{ glAccountId: defaultRevenueAccountId, ...note.tags, net: note.amount }],
      note.amount, note.number, defaultRevenueAccountId,
    );
    return { lines, allocations: [] };
  }
  const { legs, replayed, remainingVat } = await invoiceCreditBasis(companyId, note.customerInvoiceId, note.id, defaultRevenueAccountId);
  // Every leg coded (a typed invoice): proportional only, its VAT exact. Otherwise pro rata over every leg, as before.
  if (remainingVat !== null) {
    return allocateTypedCreditNote(legs, { subtotal: note.amount, taxAmount: note.taxAmount, remainingVat },
      note.number, defaultRevenueAccountId, replayed);
  }
  return allocateCreditNote(legs, note.amount, note.number, defaultRevenueAccountId, replayed);
}

/**
 * What a TYPED invoice still has to credit, for a caller raising a note against it (a dispute): its remaining net over
 * every revenue leg and its remaining VAT; null for a legacy invoice (any uncoded leg) or one with no journal.
 * `withoutNoteId`: leave that note out entirely (the apply guard, judging the note's own application to it).
 */
export async function typedInvoiceCreditState(companyId: string, invoiceId: string, withoutNoteId: string = NO_NOTE):
  Promise<{ remainingNet: number; remainingVat: number } | null> {
  // Nothing is posted here, so no leg's post account is read: the default revenue account is not needed.
  const { legs, replayed, remainingVat } = await invoiceCreditBasis(companyId, invoiceId, withoutNoteId, NO_NOTE);
  if (remainingVat === null) return null;
  return { remainingNet: remainingCarries(legs, replayed).reduce((a, b) => a + b, 0) / 100, remainingVat };
}

/**
 * The figures an invoice's credit is derived from, BEFORE any application is counted (invoiceCreditBasisRead): its legs
 * with what recorded notes took, the pre-874 notes replayed, and for a typed invoice its VAT left and what applications
 * count on it (rule A, cents). The bulk dry run simulates a batch from these with the live pure functions. Reads only.
 */
export async function invoiceCreditFigures(companyId: string, invoiceId: string, noteId: string = NO_NOTE, defaultRevenueAccountId: string = NO_NOTE):
  Promise<{ legs: RevenueLeg[]; replayed: number[]; typed: { vatLeft: number; applied: number } | null }> {
  const legs = await invoiceRevenueLegs(companyId, invoiceId, noteId, defaultRevenueAccountId);
  const replayed = (await legacyLinkedNotes(companyId, invoiceId, noteId)).map((n) => n.subtotal);
  if (!legsAreTyped(legs)) return { legs, replayed, typed: null };
  // Live customer notes APPLIED to this typed invoice but not linked to it (#1701 rounds 3-6; applying one here does
  // not link it). Each took none of its legs at approval, yet settled it: what its applications count here is RULE A
  // (creditNoteDetached): its DETACHED gross, the share of its total that reversed no leg anywhere, consumed by its
  // applications to invoices whose legs it did not reverse, in application order. So a linked note's FIFO spillover
  // counts nowhere (it reversed its own invoice's legs) and a late link to a legacy invoice cannot make an application
  // here stop counting. Their sum uses this invoice's GROSS credit capacity in its own remaining proportion
  // (appliedSettlement; the note posted its own VAT at its approval), the net taken off the legs pro rata as if
  // recorded on them, the VAT off the remaining VAT. A note linked to this invoice counts once, by its link. Unapply,
  // cancel and an adjustment down give the share back and re-derive the order.
  return { legs, replayed, typed: { vatLeft: await invoiceVatLeft(companyId, invoiceId, noteId), applied: await detachedAppliedOn(companyId, invoiceId, noteId) } };
}

/**
 * The invoice journal's revenue legs (what live earlier notes took recorded on each, and for a typed invoice what the
 * applications counted on it settle: creditNoteTypedSplit.settleApplied), the pre-874 notes to replay, and for a typed
 * invoice its remaining VAT (null if legacy). Live = not draft, not cancelled; `noteId` is excluded as well.
 */
async function invoiceCreditBasis(companyId: string, invoiceId: string, noteId: string, defaultRevenueAccountId: string):
  Promise<{ legs: RevenueLeg[]; replayed: number[]; remainingVat: number | null }> {
  const { legs, replayed, typed } = await invoiceCreditFigures(companyId, invoiceId, noteId, defaultRevenueAccountId);
  if (!typed) return { legs, replayed, remainingVat: null };
  const settled = settleApplied(legs, replayed, typed.vatLeft, typed.applied);
  return { legs: settled.legs, replayed, remainingVat: settled.remainingVat / 100 };
}

/**
 * Records what an approved note took per invoice leg (and its excess), in the
 * approval's transaction — the next note's capacity is read from these rows.
 */
export async function recordCreditNoteRevenueAllocations(
  companyId: string,
  creditNoteId: string,
  invoiceId: string,
  allocations: readonly CreditNoteAllocation[],
): Promise<void> {
  for (const a of allocations) {
    await sql`
      INSERT INTO credit_note_revenue_allocations
        (company_id, credit_note_id, invoice_id, journal_line_id, gl_account_id, project_id, cc1_id, cc2_id, bu_id,
         amount, is_excess)
      VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${invoiceId}::UUID, ${a.journalLineId}::UUID, ${a.glAccountId}::UUID,
              ${a.projectId}::UUID, ${a.cc1Id}::UUID, ${a.cc2Id}::UUID, ${a.buId}::UUID, ${a.amount}, ${a.isExcess})
    `;
  }
}

/**
 * A note unlinked until `applyCreditNoteToInvoice` links it here, which has
 * recorded nothing, debited revenue at its own approval without touching this
 * invoice's legs: one excess row, on the revenue account its journal debited,
 * says so, or it would be REPLAYED against them as a pre-874 note and crowd
 * the next note off its legs. A note that posted no revenue debit has nothing
 * to record. A note already linked keeps its link and stays replayed where it
 * took from (review #685). Caller holds the note row and the invoice's
 * credit-note lock.
 */
export async function recordLateLinkExcess(companyId: string, note: Record<string, unknown>, invoiceId: string): Promise<void> {
  if (note.customer_invoice_id || !note.gl_journal_entry_id) return;
  const recorded = (await sql`SELECT 1 FROM credit_note_revenue_allocations
    WHERE company_id = ${companyId}::UUID AND credit_note_id = ${String(note.id)}::UUID LIMIT 1`) as Record<string, unknown>[];
  if (recorded.length > 0) return;
  const debited = (await sql`
    SELECT jl.gl_account_id FROM gl_journal_lines jl
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${String(note.gl_journal_entry_id)}::UUID AND jl.company_id = ${companyId}::UUID
      AND a.account_type = 'revenue' AND jl.debit > 0
    ORDER BY jl.created_at, jl.id LIMIT 1`) as { gl_account_id: string }[];
  if (debited.length === 0) return;
  const { projectId, cc1Id, cc2Id, buId } = creditNoteHeaderOf(note);
  await recordCreditNoteRevenueAllocations(companyId, String(note.id), invoiceId, [{ journalLineId: null,
    glAccountId: String(debited[0]!.gl_account_id), projectId, cc1Id, cc2Id, buId, amount: Number(note.subtotal), isExcess: true }]);
}
