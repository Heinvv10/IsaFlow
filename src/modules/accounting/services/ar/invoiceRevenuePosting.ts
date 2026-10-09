/**
 * The revenue legs `postCustomerInvoiceToGL` and `approveCreditNote` post —
 * each poster makes ONE call here and keeps its AR and VAT legs as they were.
 * The allocation is pure (`invoiceRevenueLines.ts`); this file reads what it
 * allocates.
 */
import { sql } from '@/lib/neon';
import type { JournalLineInput } from '../../types/gl.types';
import { InvoiceLineCodingRefusal } from './invoiceLineCoding';
import { assertPostsStoredDimensions } from '../gl/dimensions/dimensionStoredPosting';
import { storedInvoiceLines, storedLinesRefusal } from './invoiceLineCodingGuard';
import {
  allocateCreditNote, buildInvoiceRevenueLines, isRevenueCoded, type CreditNoteAllocation, type LegTags, type RevenueLeg,
} from './invoiceRevenueLines';

/**
 * The invoice's revenue credit legs. `credit` is the amount the journal
 * carries; the stored lines decide only where it goes. An invoice with no
 * coded line gets the single default_revenue leg it always got. `status` is
 * the one the invoice is posted FROM: approving (draft, pending_approval)
 * refuses a line its customer's or project's FNO would add to, or a dimension
 * no longer an active master; past draft it posts as stored (#675).
 */
export async function invoiceRevenueJournalLines(
  companyId: string,
  invoiceId: string,
  invoice: { number: string; documentSubtotal: number; credit: number },
  defaultRevenueAccountId: string,
  status: string,
): Promise<JournalLineInput[]> {
  const stored = await storedInvoiceLines(companyId, invoiceId);
  const lines = stored?.lines ?? [];
  await assertPostsStoredDimensions(companyId, status, lines,
    (i) => `Invoice ${invoice.number} line ${i + 1}`, stored?.customerFnoId ?? null);
  if (lines.some(isRevenueCoded)) {
    // Under lock, against the chart as it is now — approve already refused
    // this before its first write; Post to GL and the backfills meet it here,
    // before the journal is created.
    const refusal = await storedLinesRefusal(companyId, stored);
    if (refusal) throw new InvoiceLineCodingRefusal(refusal);
  }
  return buildInvoiceRevenueLines({
    invoiceNumber: invoice.number,
    documentSubtotal: invoice.documentSubtotal,
    credit: invoice.credit,
    lines,
    defaultRevenueAccountId,
  });
}

/**
 * A customer credit note's revenue debit, and the allocation rows the caller
 * records with it (recordCreditNoteRevenueAllocations).
 *
 * Linked to an invoice that carries a journal: pro rata over that journal's
 * revenue legs (lines on revenue-type accounts, netted per account, job, CC1,
 * CC2 and BU), each capped at what it still carries — its net, less what the
 * live (approved, not cancelled) earlier notes on the invoice TOOK, as their
 * credit_note_revenue_allocations rows record it, grouped by the referenced
 * journal line's CURRENT account and tags (an account merge or a dimension
 * re-tag moves the line in place). A cancelled note's rows stop counting, so
 * its share is available again. A note approved before migration 874 has no
 * rows; its take is REPLAYED from its amount in approval order — the fallback
 * for those notes only. The excess posts untagged to default_revenue. A leg
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
  note: { id: string; number: string; amount: number; customerInvoiceId: string | null; tags: LegTags },
  defaultRevenueAccountId: string,
): Promise<{ lines: JournalLineInput[]; allocations: CreditNoteAllocation[] }> {
  if (!note.customerInvoiceId) {
    const { lines } = allocateCreditNote(
      [{ glAccountId: defaultRevenueAccountId, ...note.tags, net: note.amount }],
      note.amount, note.number, defaultRevenueAccountId,
    );
    return { lines, allocations: [] };
  }
  const invoiceLegs = (await sql`
    SELECT jl.gl_account_id, a.is_active, jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id,
           SUM(jl.credit - jl.debit) AS net,
           (array_agg(jl.id ORDER BY jl.created_at, jl.id))[1] AS journal_line_id
    FROM customer_invoices ci
    JOIN gl_journal_lines jl
      ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE ci.id = ${note.customerInvoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND a.account_type = 'revenue'
    GROUP BY jl.gl_account_id, a.is_active, jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id
    ORDER BY MIN(jl.created_at), jl.gl_account_id, jl.project_id NULLS FIRST, jl.cc1_id NULLS FIRST,
             jl.cc2_id NULLS FIRST, jl.bu_id NULLS FIRST
  `) as Record<string, unknown>[];
  // What the live earlier notes took, per leg as the journal line it names reads NOW.
  const taken = (await sql`
    SELECT jl.gl_account_id, jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id, SUM(a.amount) AS amount
    FROM credit_note_revenue_allocations a
    JOIN credit_notes cn ON cn.id = a.credit_note_id AND cn.company_id = a.company_id
    JOIN gl_journal_lines jl ON jl.id = a.journal_line_id AND jl.company_id = a.company_id
    WHERE a.company_id = ${companyId}::UUID AND a.invoice_id = ${note.customerInvoiceId}::UUID
      AND NOT a.is_excess AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${note.id}::UUID
    GROUP BY jl.gl_account_id, jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id
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
  const key = (r: Record<string, unknown>) => [r.gl_account_id, ...Object.values(tagsOf(r))].map((v) => v ?? '').join('|');
  const takenByLeg = new Map(taken.map((r) => [key(r), Number(r.amount)]));
  const legs: RevenueLeg[] = invoiceLegs.map((r) => ({
    glAccountId: String(r.gl_account_id),
    postAccountId: r.is_active === true ? String(r.gl_account_id) : defaultRevenueAccountId,
    ...tagsOf(r),
    net: Number(r.net),
    taken: takenByLeg.get(key(r)) ?? 0,
    journalLineId: String(r.journal_line_id),
  }));
  return allocateCreditNote(legs, note.amount, note.number, defaultRevenueAccountId, legacy.map((e) => Number(e.subtotal)));
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
