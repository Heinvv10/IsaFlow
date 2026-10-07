/**
 * The revenue legs `postCustomerInvoiceToGL` and `approveCreditNote` post —
 * each poster makes ONE call here and keeps its AR and VAT legs as they were.
 * The allocation is pure (`invoiceRevenueLines.ts`); this file reads what it
 * allocates.
 */
import { sql } from '@/lib/neon';
import type { JournalLineInput } from '../../types/gl.types';
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
 * A customer credit note's revenue debit (ONE posting rule, invoices and notes
 * alike: only an invoice's LINE dimensions post; a note's own project and cost
 * centre are display metadata, as the invoice header's are).
 *
 * Linked to an invoice that carries a journal: pro rata over that journal's
 * revenue legs (lines on revenue-type accounts, netted per account, project and
 * cost centre), each capped at what the earlier notes on the same invoice left
 * on it — REPLAYED from their amounts in approval order (prorateRevenueLegs),
 * never read back from the accounts they posted to. The excess, and every
 * unlinked note, posts untagged to default_revenue as before. A leg whose
 * account has since been deactivated is debited on default_revenue, keeping its
 * project and cost centre. Called with the invoice's credit-note lock held
 * (creditNotePostingChecks.lockInvoiceCreditNotes), so no other approval of a
 * note on this invoice can run between the replay and this note's write.
 */
export async function creditNoteRevenueJournalLines(
  companyId: string,
  note: { id: string; number: string; amount: number; customerInvoiceId: string | null },
  defaultRevenueAccountId: string,
): Promise<JournalLineInput[]> {
  if (!note.customerInvoiceId) return prorateRevenueLegs([], note.amount, note.number, defaultRevenueAccountId);
  const invoiceLegs = (await sql`
    SELECT jl.gl_account_id, a.is_active, jl.project_id, jl.cost_center_id,
           SUM(jl.credit - jl.debit) AS net
    FROM customer_invoices ci
    JOIN gl_journal_lines jl
      ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE ci.id = ${note.customerInvoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND a.account_type = 'revenue'
    GROUP BY jl.gl_account_id, a.is_active, jl.project_id, jl.cost_center_id
    ORDER BY MIN(jl.created_at), jl.gl_account_id, jl.project_id NULLS FIRST, jl.cost_center_id NULLS FIRST
  `) as Record<string, unknown>[];
  // Every earlier note that counts against the invoice: approved, not cancelled.
  const earlier = (await sql`
    SELECT subtotal FROM credit_notes
    WHERE company_id = ${companyId}::UUID AND customer_invoice_id = ${note.customerInvoiceId}::UUID
      AND type = 'customer' AND status NOT IN ('draft', 'cancelled') AND id <> ${note.id}::UUID
    ORDER BY approved_at NULLS FIRST, id
  `) as { subtotal: string }[];

  const id = (v: unknown): string | null => (v == null ? null : String(v));
  const legs: RevenueLeg[] = invoiceLegs.map((r) => ({
    glAccountId: String(r.gl_account_id),
    postAccountId: r.is_active === true ? String(r.gl_account_id) : defaultRevenueAccountId,
    projectId: id(r.project_id),
    costCenterId: id(r.cost_center_id),
    net: Number(r.net),
  }));
  return prorateRevenueLegs(legs, note.amount, note.number, defaultRevenueAccountId, earlier.map((e) => Number(e.subtotal)));
}
