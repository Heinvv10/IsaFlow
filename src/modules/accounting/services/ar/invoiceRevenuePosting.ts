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
  allocateCreditNote, isRevenueCoded, type CreditNoteAllocation, type LegTags, type RevenueLeg,
} from './invoiceRevenueLines';
import { storedVatType, type StoredVatLine } from './invoiceVatLegs';
import { allocateTypedCreditNote, legsAreTyped } from './creditNoteTypedSplit';

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
    /** The note's VAT and date: against a TYPED invoice they decide its rated part (creditNoteTypedSplit). */
    taxAmount: number; date: string | Date;
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
  // One leg per revenue journal line, keyed by the line itself: a re-tag or an account merge moves
  // the line in place, so what earlier notes took from it moves with it (two lines merged into one
  // group, then one re-tagged, reopened the group's capacity — review #685).
  const invoiceLegs = (await sql`
    SELECT jl.id AS journal_line_id, jl.gl_account_id, a.is_active, jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id,
           jl.vat_type, jl.credit - jl.debit AS net
    FROM customer_invoices ci
    JOIN gl_journal_lines jl
      ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE ci.id = ${note.customerInvoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND a.account_type = 'revenue'
    ORDER BY jl.created_at, jl.id
  `) as Record<string, unknown>[];
  // What the live earlier notes took, per journal line.
  const taken = (await sql`
    SELECT a.journal_line_id, SUM(a.amount) AS amount
    FROM credit_note_revenue_allocations a
    JOIN credit_notes cn ON cn.id = a.credit_note_id AND cn.company_id = a.company_id
    WHERE a.company_id = ${companyId}::UUID AND a.invoice_id = ${note.customerInvoiceId}::UUID
      AND NOT a.is_excess AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${note.id}::UUID
    GROUP BY a.journal_line_id
  `) as Record<string, unknown>[];
  // Live earlier notes that recorded nothing: approved before 874 — replayed.
  const legacy = (await sql`
    SELECT cn.subtotal FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${note.customerInvoiceId}::UUID
      AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${note.id}::UUID
      AND NOT EXISTS (SELECT 1 FROM credit_note_revenue_allocations a
                      WHERE a.company_id = cn.company_id AND a.credit_note_id = cn.id)
    ORDER BY cn.approved_at NULLS FIRST, cn.id
  `) as { subtotal: string }[];

  const id = (v: unknown): string | null => (v == null ? null : String(v));
  const tagsOf = (r: Record<string, unknown>): LegTags => ({
    projectId: id(r.project_id), cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id),
  });
  const takenByLeg = new Map(taken.map((r) => [String(r.journal_line_id), Number(r.amount)]));
  const legs: RevenueLeg[] = invoiceLegs.map((r) => ({
    glAccountId: String(r.gl_account_id),
    postAccountId: r.is_active === true ? String(r.gl_account_id) : defaultRevenueAccountId,
    ...tagsOf(r),
    net: Number(r.net),
    taken: takenByLeg.get(String(r.journal_line_id)) ?? 0,
    journalLineId: String(r.journal_line_id),
    // A typed invoice's leg (migration 1008): the note reverses it on the same VAT type. Uncoded stays uncoded.
    vatType: storedVatType(r.vat_type),
  }));
  const replayed = legacy.map((e) => Number(e.subtotal));
  // Every leg coded (a typed invoice): the note's VAT decides its rated part. Otherwise pro rata over every leg, as before.
  if (legsAreTyped(legs)) {
    // The VAT the invoice's rated legs still carry: its VAT Output legs less its live earlier notes' VAT (review round 3).
    const vat = (await sql`
      SELECT (SELECT COALESCE(SUM(jl.credit - jl.debit), 0)
              FROM customer_invoices ci
              JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
              JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
              WHERE ci.id = ${note.customerInvoiceId}::UUID AND ci.company_id = ${companyId}::UUID
                AND COALESCE(a.account_subtype, '') = 'vat_output') AS invoice_vat,
             (SELECT COALESCE(SUM(cn.tax_amount), 0) FROM credit_notes cn
              WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${note.customerInvoiceId}::UUID
                AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${note.id}::UUID) AS reversed_vat
    `) as Record<string, unknown>[];
    // One row always (two scalar subqueries); none read as no VAT left, which refuses any VAT on the note.
    const remainingRatedVat = vat[0] ? Number(vat[0].invoice_vat) - Number(vat[0].reversed_vat) : 0;
    return allocateTypedCreditNote(legs, { subtotal: note.amount, taxAmount: note.taxAmount, date: note.date, remainingRatedVat },
      note.number, defaultRevenueAccountId, replayed);
  }
  return allocateCreditNote(legs, note.amount, note.number, defaultRevenueAccountId, replayed);
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
