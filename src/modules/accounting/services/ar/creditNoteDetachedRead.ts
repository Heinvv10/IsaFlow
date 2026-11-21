/**
 * Reads RULE A's inputs (creditNoteDetached): each live customer note's total, subtotal and the net its non-excess
 * credit_note_revenue_allocations rows record (D), the invoices those rows are on (the legs it reversed), and its
 * applications in application order (created_at, invoice_id). Company-scoped; every figure in exact cents (ROUND in
 * SQL on NUMERIC(15,2), no float on the way). Live = not draft, not cancelled.
 */
import { sql } from '@/lib/neon';
import { detachedCounts, detachedGross, type DetachedProfile } from './creditNoteDetached';

type Row = Record<string, unknown>;

const toProfile = (r: Row): DetachedProfile => ({
  detached: detachedGross(Number(r.total_cents), Number(r.subtotal_cents), Number(r.reversed_cents)),
  reversedOn: (r.reversed_on as string[] | null) ?? [],
  applications: ((r.applications as [string, number | string][] | null) ?? []).map(([invoiceId, cents]) => ({ invoiceId, cents: Number(cents) })),
});

/**
 * What the applications to `invoiceId` of live customer notes NOT linked to it count there under rule A, in cents,
 * summed (the caller splits the sum in the invoice's own proportion). `noteId` (the note being judged) is left out.
 * One query: every such note's profile, with all its applications (D is consumed across its invoices in order).
 */
export async function detachedAppliedOn(companyId: string, invoiceId: string, noteId: string): Promise<number> {
  const rows = (await sql`
    SELECT ROUND(cn.total_amount * 100)::BIGINT AS total_cents, ROUND(cn.subtotal * 100)::BIGINT AS subtotal_cents,
           (SELECT ROUND(COALESCE(SUM(r.amount), 0) * 100)::BIGINT FROM credit_note_revenue_allocations r
            WHERE r.company_id = cn.company_id AND r.credit_note_id = cn.id AND NOT r.is_excess) AS reversed_cents,
           (SELECT COALESCE(jsonb_agg(DISTINCT r.invoice_id::TEXT), '[]'::JSONB) FROM credit_note_revenue_allocations r
            WHERE r.company_id = cn.company_id AND r.credit_note_id = cn.id AND NOT r.is_excess) AS reversed_on,
           (SELECT COALESCE(jsonb_agg(jsonb_build_array(a.invoice_id::TEXT, ROUND(a.amount_allocated * 100)::BIGINT)
                                      ORDER BY a.created_at, a.invoice_id), '[]'::JSONB)
            FROM credit_note_allocations a WHERE a.company_id = cn.company_id AND a.credit_note_id = cn.id) AS applications
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled')
      AND cn.id <> ${noteId}::UUID AND cn.customer_invoice_id IS DISTINCT FROM ${invoiceId}::UUID
      AND EXISTS (SELECT 1 FROM credit_note_allocations y
                  WHERE y.company_id = cn.company_id AND y.credit_note_id = cn.id AND y.invoice_id = ${invoiceId}::UUID)
  `) as Row[];
  const id = invoiceId.toLowerCase();
  return rows.reduce((sum, r) => sum + (detachedCounts(toProfile(r)).get(id) ?? 0), 0);
}

/** The rule-A profiles of these live customer notes (the back-fill's dry run consumes capacity by them). */
export async function detachedProfiles(companyId: string, noteIds: readonly string[]): Promise<Map<string, DetachedProfile>> {
  if (noteIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT cn.id::TEXT AS id,
           ROUND(cn.total_amount * 100)::BIGINT AS total_cents, ROUND(cn.subtotal * 100)::BIGINT AS subtotal_cents,
           (SELECT ROUND(COALESCE(SUM(r.amount), 0) * 100)::BIGINT FROM credit_note_revenue_allocations r
            WHERE r.company_id = cn.company_id AND r.credit_note_id = cn.id AND NOT r.is_excess) AS reversed_cents,
           (SELECT COALESCE(jsonb_agg(DISTINCT r.invoice_id::TEXT), '[]'::JSONB) FROM credit_note_revenue_allocations r
            WHERE r.company_id = cn.company_id AND r.credit_note_id = cn.id AND NOT r.is_excess) AS reversed_on,
           (SELECT COALESCE(jsonb_agg(jsonb_build_array(a.invoice_id::TEXT, ROUND(a.amount_allocated * 100)::BIGINT)
                                      ORDER BY a.created_at, a.invoice_id), '[]'::JSONB)
            FROM credit_note_allocations a WHERE a.company_id = cn.company_id AND a.credit_note_id = cn.id) AS applications
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.type = 'customer' AND cn.status NOT IN ('draft', 'cancelled')
      AND cn.id = ANY(${[...noteIds]}::UUID[])
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id), toProfile(r)]));
}
