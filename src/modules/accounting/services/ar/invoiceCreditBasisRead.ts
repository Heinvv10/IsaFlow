/**
 * The ONE place an invoice's credit basis is read (#1701 round 9): its journal's revenue legs with what live earlier
 * notes took from each, the live linked notes approved before 874 (no allocation row: REPLAYED, in approval order),
 * and for a typed invoice its VAT left. invoiceRevenuePosting.invoiceCreditBasis (posting, the typed state, the apply
 * gate) and creditNoteLegacyReplay (rule A's detached gross of such a note) both read through it, so the replay they
 * run is over the same legs and the same notes. Company-scoped; live = not draft, not cancelled; `noteId` (the note
 * being approved, a draft at this read) is excluded.
 */
import { sql } from '@/lib/neon';
import type { LegTags, RevenueLeg } from './invoiceRevenueLines';
import { storedVatType } from './invoiceVatLegs';

/** A note id no note has: what a caller with no note yet excludes. */
export const NO_NOTE = '00000000-0000-0000-0000-000000000000';

/** The invoice journal's revenue legs, each with what live earlier notes took from it (its allocation rows). */
export async function invoiceRevenueLegs(companyId: string, invoiceId: string, noteId: string, defaultRevenueAccountId: string):
  Promise<RevenueLeg[]> {
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
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND a.account_type = 'revenue'
    ORDER BY jl.created_at, jl.id
  `) as Record<string, unknown>[];
  // What the live earlier notes took, per journal line.
  const taken = (await sql`
    SELECT a.journal_line_id, SUM(a.amount) AS amount
    FROM credit_note_revenue_allocations a
    JOIN credit_notes cn ON cn.id = a.credit_note_id AND cn.company_id = a.company_id
    WHERE a.company_id = ${companyId}::UUID AND a.invoice_id = ${invoiceId}::UUID
      AND NOT a.is_excess AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${noteId}::UUID
    GROUP BY a.journal_line_id
  `) as Record<string, unknown>[];
  const id = (v: unknown): string | null => (v == null ? null : String(v));
  const tagsOf = (r: Record<string, unknown>): LegTags => ({
    projectId: id(r.project_id), cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id),
  });
  const takenByLeg = new Map(taken.map((r) => [String(r.journal_line_id), Number(r.amount)]));
  return invoiceLegs.map((r) => ({
    glAccountId: String(r.gl_account_id),
    postAccountId: r.is_active === true ? String(r.gl_account_id) : defaultRevenueAccountId,
    ...tagsOf(r),
    net: Number(r.net),
    taken: takenByLeg.get(String(r.journal_line_id)) ?? 0,
    journalLineId: String(r.journal_line_id),
    // A typed invoice's leg (migration 1008): the note reverses it on the same VAT type. Uncoded stays uncoded.
    vatType: storedVatType(r.vat_type),
  }));
}

/** Live linked notes that recorded nothing (approved before 874), in approval order: the notes posting replays. */
export async function legacyLinkedNotes(companyId: string, invoiceId: string, noteId: string): Promise<{ id: string; subtotal: number }[]> {
  const rows = (await sql`
    SELECT cn.id::TEXT AS id, cn.subtotal FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${invoiceId}::UUID
      AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${noteId}::UUID
      AND NOT EXISTS (SELECT 1 FROM credit_note_revenue_allocations a
                      WHERE a.company_id = cn.company_id AND a.credit_note_id = cn.id)
    ORDER BY cn.approved_at NULLS FIRST, cn.id
  `) as { id: string; subtotal: string }[];
  return rows.map((r) => ({ id: r.id, subtotal: Number(r.subtotal) }));
}

/** A typed invoice's VAT left (cents): its VAT Output legs less the tax of its live earlier customer notes. */
export async function invoiceVatLeft(companyId: string, invoiceId: string, noteId: string): Promise<number> {
  const vat = (await sql`
    SELECT (SELECT COALESCE(SUM(jl.credit - jl.debit), 0)
            FROM customer_invoices ci
            JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
            JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
            WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
              AND COALESCE(a.account_subtype, '') = 'vat_output') AS invoice_vat,
           (SELECT COALESCE(SUM(cn.tax_amount), 0) FROM credit_notes cn
            WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${invoiceId}::UUID
              AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${noteId}::UUID) AS reversed_vat
  `) as Record<string, unknown>[];
  // One row always (two scalar subqueries).
  return vat[0] ? Math.round((Number(vat[0].invoice_vat) - Number(vat[0].reversed_vat)) * 100) : 0;
}
