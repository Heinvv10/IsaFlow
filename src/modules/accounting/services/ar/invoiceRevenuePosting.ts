/**
 * The revenue legs `postCustomerInvoiceToGL` and `approveCreditNote` post —
 * each poster makes ONE call here and keeps its AR and VAT legs as they were.
 * The allocation is pure (`invoiceRevenueLines.ts`); this file reads what it
 * allocates.
 */
import { sql } from '@/lib/neon';
import type { JournalLineInput } from '../../types/gl.types';
import { ownedDimensions, ownedOrNull } from '../gl/journalLineOwnership';
import { InvoiceLineCodingRefusal, isCoded } from './invoiceLineCoding';
import { storedInvoiceLines, storedLinesRefusal } from './invoiceLineCodingGuard';
import { buildInvoiceRevenueLines, prorateRevenueLegs, type RevenueLeg } from './invoiceRevenueLines';

/**
 * The invoice's revenue credit legs. `credit` is the amount the journal
 * carries; the stored lines decide only where it goes. An invoice with no
 * coded line gets the single default_revenue leg it always got.
 */
export async function invoiceRevenueJournalLines(
  companyId: string,
  invoiceId: string,
  invoice: { number: string; documentSubtotal: number; credit: number },
  defaultRevenueAccountId: string,
): Promise<JournalLineInput[]> {
  const stored = await storedInvoiceLines(companyId, invoiceId);
  const lines = stored?.lines ?? [];
  if (lines.some(isCoded)) {
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
 * A customer credit note's revenue debit. Linked to an invoice that carries a
 * journal: pro rata over that journal's revenue legs (lines on revenue-type
 * accounts, netted per account, project and cost centre), so the note
 * reverses where the invoice credited. Otherwise — no link, no journal (a
 * cancelled invoice), or legs that net to nothing — the default_revenue debit
 * it always posted, tagged with the note's own project and cost centre when
 * this company owns them.
 */
export async function creditNoteRevenueJournalLines(
  companyId: string,
  note: {
    number: string; amount: number; customerInvoiceId: string | null;
    projectId: string | null; costCenterId: string | null;
  },
  defaultRevenueAccountId: string,
): Promise<JournalLineInput[]> {
  if (note.customerInvoiceId) {
    const rows = (await sql`
      SELECT jl.gl_account_id, jl.project_id, jl.cost_center_id,
             SUM(jl.credit - jl.debit) AS net
      FROM customer_invoices ci
      JOIN gl_journal_lines jl
        ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
      JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
      WHERE ci.id = ${note.customerInvoiceId}::UUID AND ci.company_id = ${companyId}::UUID
        AND a.account_type = 'revenue'
      GROUP BY jl.gl_account_id, jl.project_id, jl.cost_center_id
      ORDER BY MIN(jl.created_at), jl.gl_account_id, jl.project_id NULLS FIRST, jl.cost_center_id NULLS FIRST
    `) as Record<string, unknown>[];
    const legs: RevenueLeg[] = rows.map((r) => ({
      glAccountId: String(r.gl_account_id),
      projectId: r.project_id == null ? null : String(r.project_id),
      costCenterId: r.cost_center_id == null ? null : String(r.cost_center_id),
      net: Number(r.net),
    }));
    const prorated = prorateRevenueLegs(legs, note.amount, note.number);
    if (prorated) return prorated;
  }

  const line: JournalLineInput = {
    glAccountId: defaultRevenueAccountId, debit: note.amount, credit: 0,
    description: `Credit note ${note.number}`,
  };
  if (note.projectId || note.costCenterId) {
    // Carried, not asserted: credit_notes.project_id was never validated on
    // write, so a legacy note may name another company's project. Dropped
    // rather than refused, as the reversal and reclassification copiers do.
    const owned = await ownedDimensions(companyId, {
      project: [note.projectId], costCentre: [note.costCenterId], businessUnit: [],
    });
    const projectId = ownedOrNull(owned.project, note.projectId);
    const costCenterId = ownedOrNull(owned.costCentre, note.costCenterId);
    if (projectId) line.projectId = projectId;
    if (costCenterId) line.costCenterId = costCenterId;
  }
  return [line];
}
