/**
 * Reads RULE A's inputs (creditNoteDetached): each live customer note's total, subtotal and the net its non-excess
 * credit_note_revenue_allocations rows record (D), the invoices those rows are on (the legs it reversed), and its
 * applications in application order (created_at, invoice_id). ONE statement for both callers; company-scoped; every
 * figure in exact cents (ROUND in SQL on NUMERIC(15,2), no float on the way). Live = not draft, not cancelled.
 */
import { sql } from '@/lib/neon';
import { detachedCounts, detachedGross, type DetachedProfile } from './creditNoteDetached';

type Row = Record<string, unknown>;

/**
 * The profiles of the live customer notes either named in `noteIds`, or (`appliedTo`) applied to that invoice, less
 * `withoutNoteId`. Exactly one of the two filters is set.
 */
async function readProfiles(companyId: string, filter: { noteIds: readonly string[] } | { appliedTo: string; withoutNoteId: string }):
  Promise<Map<string, DetachedProfile>> {
  const ids = 'noteIds' in filter ? [...filter.noteIds] : null;
  const appliedTo = 'appliedTo' in filter ? filter.appliedTo : null;
  const without = 'appliedTo' in filter ? filter.withoutNoteId : null;
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
      AND (${ids}::UUID[] IS NULL OR cn.id = ANY(${ids}::UUID[]))
      AND (${appliedTo}::UUID IS NULL OR (cn.id <> ${without}::UUID AND EXISTS (
            SELECT 1 FROM credit_note_allocations y
            WHERE y.company_id = cn.company_id AND y.credit_note_id = cn.id AND y.invoice_id = ${appliedTo}::UUID)))
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id), {
    detached: detachedGross(Number(r.total_cents), Number(r.subtotal_cents), Number(r.reversed_cents)),
    reversedOn: (r.reversed_on as string[] | null) ?? [],
    applications: ((r.applications as [string, number | string][] | null) ?? []).map(([invoiceId, cents]) => ({ invoiceId, cents: Number(cents) })),
  }]));
}

/**
 * What the applications to `invoiceId` of the live customer notes count there under rule A, in cents, summed (the
 * caller splits the sum in the invoice's own proportion). `noteId` (the note being judged) is left out. A note whose
 * legs on this invoice it reversed (non-excess allocation rows here: a note linked to it) counts nothing here by
 * detachedCounts itself; the invoice sees it by its allocation rows and its VAT by its link (round 7: the rows decide,
 * not the link; on a typed invoice the two agree, r6 integration case 8). One query.
 */
export async function detachedAppliedOn(companyId: string, invoiceId: string, noteId: string): Promise<number> {
  const id = invoiceId.toLowerCase();
  const profiles = await readProfiles(companyId, { appliedTo: invoiceId, withoutNoteId: noteId });
  return [...profiles.values()].reduce((sum, p) => sum + (detachedCounts(p).get(id) ?? 0), 0);
}

/** The rule-A profiles of these live customer notes (the back-fill's dry run and the unapply / adjust guard). */
export async function detachedProfiles(companyId: string, noteIds: readonly string[]): Promise<Map<string, DetachedProfile>> {
  if (noteIds.length === 0) return new Map();
  return readProfiles(companyId, { noteIds });
}
