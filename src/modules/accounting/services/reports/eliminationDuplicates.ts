/**
 * Stored eliminations against the mirrored documents (whose eliminations are derived, mirrorEliminations.ts).
 *
 * RULING 2026-11-21 (Hein), the per-pair cutover: from the date both companies of a pair have mirroring on (intercompany_pair_cutovers), the
 * pair's invoices and credit notes that mirroring covers (ZAR, approved by the receiver, expense lines in one financial year, mapped accounts:
 * manualReason.ts mirrorCoverage) are eliminated by mirroring only. The generator drafts nothing for the pair's sale-class rows dated on or
 * after it that a standing mirror eliminates (eliminationGenerator.ts), and a hand-made elimination dated on or after a cutover of the group needs a typed reason (below).
 *
 * Before the cutover a manual row can still be the same sale as a mirror (a document dated after the connection's cut-over date but approved
 * once both sides were on is mirrored): intercompany_mirrored_duplicate flags it (a plain match), and posting a matching draft needs the
 * person's confirm. What the list and the 409 SAY about it comes from intercompany_mirror_facts only (mirrorFacts.ts), read once per adjustment.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { EliminationCoveredError, EliminationNotUnresolvedError, EliminationPossibleDuplicateError, EliminationStateError } from './eliminationErrors';
import { factsFromRows } from './mirrorFacts';

/** The group's mirroring pairs and their cutover dates (YYYY-MM-DD), keyed by `${low}|${high}` (lowercase uuids). */
export async function getPairCutovers(groupId: string): Promise<Map<string, string>> {
  const rows = (await sql`SELECT company_low_id, company_high_id, cutover::TEXT AS cutover FROM public.intercompany_pair_cutovers(${groupId}::UUID)`) as DbRow[];
  return new Map(rows.map((r) => [`${String(r.company_low_id).toLowerCase()}|${String(r.company_high_id).toLowerCase()}`, String(r.cutover)]));
}

/** The cutover of the pair (a, b), in either order, or null when the pair does not mirror. */
export function pairCutover(cutovers: Map<string, string>, a: string, b: string): string | null {
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return cutovers.get(x < y ? `${x}|${y}` : `${y}|${x}`) ?? null;
}

/**
 * The earliest cutover of the group's mirroring pairs on or before `date` (a hand-made elimination names no companies, so its pair cannot be
 * told from its lines: one dated on or after ANY cutover of the group needs a reason). `date` null (no period given): any cutover counts.
 */
export async function cutoverRequiringReason(groupId: string, date: string | null): Promise<string | null> {
  const cutovers = [...(await getPairCutovers(groupId)).values()].filter((c) => date === null || c <= date).sort();
  return cutovers[0] ?? null;
}

/**
 * The stored adjustments of the list, each (draft or posted) with the facts of its possible mirrored duplicate for the adjustment's period
 * (intercompany_mirror_facts, one row per named mirror, as JSON: mirror_facts), its pair's cutover when the row is on or after it, and how many
 * listed adjustments name the same mirror(s).
 */
export async function storedEliminationRows(groupId: string, pStart: string | null, pEnd: string | null): Promise<DbRow[]> {
  return (await sql`
    WITH pc AS MATERIALIZED (SELECT * FROM public.intercompany_pair_cutovers(${groupId}::UUID)
    ), s AS MATERIALIZED (
      SELECT ca.*, ca.period_end::TEXT AS facts_period_end,
             -- the row is on or after its pair's cutover (sale class): it was drafted because no standing mirror is left to it
             (SELECT pc.cutover::TEXT FROM intercompany_transactions t JOIN pc
                ON pc.company_low_id = LEAST(t.source_company_id, t.target_company_id) AND pc.company_high_id = GREATEST(t.source_company_id, t.target_company_id)
               WHERE t.id = ca.source_intercompany_id AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee') AND t.transaction_date >= pc.cutover) AS pair_cutover
        FROM consolidation_adjustments ca
       WHERE ca.group_id = ${groupId}::UUID AND ca.status <> 'discarded'
         -- an older generator's adjustment of a MIRRORED row (e.g. after a code rollback) is never shown: its figure is derived. A person's (it carries a reason) is
         AND (ca.source_intercompany_id IS NULL OR ca.manual_reason IS NOT NULL OR NOT public.intercompany_is_mirrored_row(ca.source_intercompany_id))
         AND (${pStart}::DATE IS NULL OR ca.period_start >= ${pStart}::DATE)
         AND (${pEnd}::DATE IS NULL OR ca.period_end <= ${pEnd}::DATE)
    ), f AS MATERIALIZED (
      -- what is true of the possible duplicate, judged ONCE per adjustment for its period
      SELECT s.id AS adj_id, x.* FROM s CROSS JOIN LATERAL public.intercompany_mirror_facts(s.source_intercompany_id, s.period_end::DATE) x
       WHERE s.source_intercompany_id IS NOT NULL AND s.status IN ('draft', 'posted')
    ), fa AS (
      SELECT f.adj_id, json_agg(json_build_object('label', f.label, 'is_sum', f.is_sum, 'ord', f.ord, 'mirror_ref', f.mirror_ref, 'amount', f.amount,
                                                  'stands', f.stands, 'link', f.link, 'by_total', f.by_total, 'elim_date', f.elim_date::TEXT,
                                                  'other_role', f.other_role, 'by_person', f.by_person) ORDER BY f.ord) AS mirror_facts,
             array_agg(f.mirror_row ORDER BY f.mirror_row) AS mset
        FROM f GROUP BY f.adj_id
    )
    SELECT s.*, fa.mirror_facts, CASE WHEN fa.mset IS NOT NULL THEN count(*) OVER (PARTITION BY fa.mset) END AS mirror_shared
      FROM s LEFT JOIN fa ON fa.adj_id = s.id
     ORDER BY s.created_at DESC
  `) as DbRow[];
}

/**
 * Posts a draft. A draft whose row may be the same sale as a live mirrored document is refused (EliminationPossibleDuplicateError, worded
 * from that row's mirror facts) unless `confirmDuplicate`: the person saw what is true and confirmed. A person's draft of a MIRRORED row is
 * refused (EliminationNotUnresolvedError) once the row is no longer one the mirror leaves un-eliminated (the receiver accepted it since), and
 * (EliminationCoveredError) once a posted elimination of a manual row may be the same sale (intercompany_manual_cover).
 */
export async function postEliminationAdjustment(adjustmentId: string, groupId: string, confirmDuplicate = false): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments ca SET status='posted', posted_at=NOW(), updated_at=NOW()
      WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.status='draft'
        AND (${confirmDuplicate}::BOOLEAN OR ca.source_intercompany_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.intercompany_mirrored_duplicate(ca.source_intercompany_id, ca.period_end::DATE)))
        -- a person's elimination of a MIRRORED row is posted only while the row is still listed as unresolved for its period (else the mirror eliminates it now)
        -- and no posted elimination of a manual row may be the same sale
        AND (ca.source_intercompany_id IS NULL OR ca.manual_reason IS NULL OR NOT public.intercompany_is_mirrored_row(ca.source_intercompany_id)
             OR (EXISTS (SELECT 1 FROM public.intercompany_mirror_unresolved(ca.group_id, ca.period_start, ca.period_end) u WHERE u.transaction_id = ca.source_intercompany_id)
                 AND NOT EXISTS (SELECT 1 FROM public.intercompany_manual_cover(ca.source_intercompany_id))))
      RETURNING ca.id
    `) as DbRow[];
    if (result.length === 0) {
      const dup = (await sql`
        SELECT ca.period_end::TEXT AS pe, ca.source_intercompany_id AS row_id, ca.period_start::TEXT AS ps,
               (ca.manual_reason IS NOT NULL AND public.intercompany_is_mirrored_row(ca.source_intercompany_id)
                AND NOT EXISTS (SELECT 1 FROM public.intercompany_mirror_unresolved(ca.group_id, ca.period_start, ca.period_end) u WHERE u.transaction_id = ca.source_intercompany_id)) AS gone,
               (SELECT to_jsonb(c) FROM public.intercompany_manual_cover(ca.source_intercompany_id) c WHERE ca.manual_reason IS NOT NULL) AS cover,
               (SELECT json_agg(to_jsonb(f) ORDER BY f.ord) FROM public.intercompany_mirror_facts(ca.source_intercompany_id, ca.period_end::DATE) f) AS facts,
               (SELECT pc.cutover::TEXT FROM intercompany_transactions t JOIN public.intercompany_pair_cutovers(${groupId}::UUID) pc
                  ON pc.company_low_id = LEAST(t.source_company_id, t.target_company_id) AND pc.company_high_id = GREATEST(t.source_company_id, t.target_company_id)
                 WHERE t.id = ca.source_intercompany_id AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee') AND t.transaction_date >= pc.cutover) AS pair_cutover
          FROM consolidation_adjustments ca
         WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.status='draft' AND ca.source_intercompany_id IS NOT NULL
      `) as DbRow[] | undefined;
      if (Array.isArray(dup) && dup[0]?.gone) throw new EliminationNotUnresolvedError(String(dup[0].row_id), `${String(dup[0].ps)} to ${String(dup[0].pe)}`);
      const cover = Array.isArray(dup) ? dup[0]?.cover as { description?: string; period_start?: string; period_end?: string } | null | undefined : null;
      if (cover) throw new EliminationCoveredError(String(dup![0]!.row_id), String(cover.description ?? '(no description)'), `${cover.period_start} to ${cover.period_end}`);
      const facts = Array.isArray(dup) && dup[0] ? factsFromRows(dup[0].facts as DbRow[] | null, String(dup[0].pe)) : null;
      if (!confirmDuplicate && facts) throw new EliminationPossibleDuplicateError(adjustmentId, facts, dup![0]!.pair_cutover ? String(dup![0]!.pair_cutover) : null);
      throw new EliminationStateError(adjustmentId, 'draft');
    }
    log.info('Posted elimination adjustment', { adjustmentId, groupId, confirmDuplicate }, 'accounting');
  } catch (err) {
    log.error('Failed to post elimination adjustment', { adjustmentId, groupId, error: err }, 'accounting');
    throw err;
  }
}
