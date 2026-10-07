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
 * cost centre), each capped at what earlier posted notes on the same invoice
 * left on it — the excess, and every unlinked note, posts untagged to
 * default_revenue as before. Read and decided BEFORE the journal is created:
 * a leg whose account has since been deactivated (a year-end clean-up) is
 * debited on default_revenue instead, keeping its project and cost centre, so
 * posting never refuses it after the draft journal exists.
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
  // What earlier notes on this invoice already took back, from their POSTED journals.
  const consumedRows = (await sql`
    SELECT jl.gl_account_id, jl.project_id, jl.cost_center_id, SUM(jl.debit - jl.credit) AS consumed
    FROM credit_notes cn
    JOIN gl_journal_entries je
      ON je.id = cn.gl_journal_entry_id AND je.company_id = cn.company_id AND je.status = 'posted'
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${note.customerInvoiceId}::UUID
      AND cn.type = 'customer' AND cn.status <> 'cancelled' AND cn.id <> ${note.id}::UUID
      AND a.account_type = 'revenue'
    GROUP BY jl.gl_account_id, jl.project_id, jl.cost_center_id
  `) as Record<string, unknown>[];

  const id = (v: unknown): string | null => (v == null ? null : String(v));
  const keyOf = (account: string, project: string | null, centre: string | null) => `${account}|${project ?? ''}|${centre ?? ''}`;
  const consumed = new Map(consumedRows.map((r) => [
    keyOf(String(r.gl_account_id), id(r.project_id), id(r.cost_center_id)), Number(r.consumed)]));
  // Folded onto the account the leg posts to NOW, so an earlier note that took
  // the same fallback is matched against it.
  const legs = new Map<string, RevenueLeg>();
  for (const r of invoiceLegs) {
    const glAccountId = r.is_active === true ? String(r.gl_account_id) : defaultRevenueAccountId;
    const key = keyOf(glAccountId, id(r.project_id), id(r.cost_center_id));
    const leg = legs.get(key) ?? { glAccountId, projectId: id(r.project_id), costCenterId: id(r.cost_center_id), net: 0 };
    leg.net += Number(r.net);
    legs.set(key, leg);
  }
  const remaining = [...legs.entries()].map(([key, leg]) => {
    const left = leg.net - (consumed.get(key) ?? 0);
    return { ...leg, net: leg.net >= 0 ? Math.max(0, left) : Math.min(0, left) };
  });
  return prorateRevenueLegs(remaining, note.amount, note.number, defaultRevenueAccountId);
}
