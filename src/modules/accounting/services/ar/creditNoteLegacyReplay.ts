/**
 * What each live customer note linked to an invoice with NO allocation rows (approved before migration 874) reversed
 * of that invoice's revenue legs, by the SAME replay posting uses (invoiceRevenueLines.replayLegacyNotes, over the same
 * legs and the same notes in the same order as invoiceRevenuePosting.invoiceCreditBasis). Rule A's detached gross of
 * such a note is then only its true excess (creditNoteDetachedRead; #1701 round 8 item 6: treating its whole gross as
 * detached counted it against another typed invoice as well, so the credit was consumed twice). Company-scoped.
 */
import { sql } from '@/lib/neon';
import { replayLegacyNotes, type RevenueLeg } from './invoiceRevenueLines';

/** note id -> the net (cents) the replay has it take from `invoiceId`'s legs. */
export async function legacyReplayTakes(companyId: string, invoiceId: string): Promise<Map<string, number>> {
  const legs = (await sql`
    SELECT jl.credit - jl.debit AS net
    FROM customer_invoices ci
    JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID AND a.account_type = 'revenue'
    ORDER BY jl.created_at, jl.id
  `) as { net: string }[];
  const notes = (await sql`
    SELECT cn.id::TEXT AS id, cn.subtotal FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${invoiceId}::UUID
      AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM credit_note_revenue_allocations a
                      WHERE a.company_id = cn.company_id AND a.credit_note_id = cn.id)
    ORDER BY cn.approved_at NULLS FIRST, cn.id
  `) as { id: string; subtotal: string }[];
  // Only each leg's net is read by the replay.
  const asLegs = legs.map((l) => ({ net: Number(l.net) }) as RevenueLeg);
  const { took } = replayLegacyNotes(asLegs, notes.map((n) => Number(n.subtotal)));
  return new Map(notes.map((n, i) => [n.id, took[i]!]));
}
