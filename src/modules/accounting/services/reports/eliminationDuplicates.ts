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
import { EliminationMirroredRowUnsupportedError, EliminationPossibleDuplicateError, EliminationStateError } from './eliminationErrors';
import { factsFromRows } from './mirrorFacts';

/** The group's mirroring pairs and their cutover dates (YYYY-MM-DD), keyed by `${low}|${high}` (lowercase uuids). */
export async function getPairCutovers(groupId: string): Promise<Map<string, string>> {
  const rows = (await sql`SELECT company_low_id, company_high_id, to_char(cutover, 'YYYY-MM-DD') AS cutover FROM public.intercompany_pair_cutovers(${groupId}::UUID)`) as DbRow[];
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
      SELECT ca.*, to_char(ca.period_end, 'YYYY-MM-DD') AS facts_period_end,
             -- the row is on or after its pair's cutover (sale class): it was drafted because no standing mirror is left to it
             (SELECT to_char(pc.cutover, 'YYYY-MM-DD') FROM intercompany_transactions t JOIN pc
                ON pc.company_low_id = LEAST(t.source_company_id, t.target_company_id) AND pc.company_high_id = GREATEST(t.source_company_id, t.target_company_id)
               WHERE t.id = ca.source_intercompany_id AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee') AND t.transaction_date >= pc.cutover) AS pair_cutover
        FROM consolidation_adjustments ca
       WHERE ca.group_id = ${groupId}::UUID
         -- a stored adjustment of a MIRRORED row (written by an older generator, e.g. after a code rollback) is never shown: its figure is derived
         AND (ca.source_intercompany_id IS NULL OR NOT public.intercompany_is_mirrored_row(ca.source_intercompany_id))
         AND (${pStart}::DATE IS NULL OR ca.period_start >= ${pStart}::DATE)
         AND (${pEnd}::DATE IS NULL OR ca.period_end <= ${pEnd}::DATE)
    ), f AS MATERIALIZED (
      -- what is true of the possible duplicate, judged ONCE per adjustment for its period
      SELECT s.id AS adj_id, x.* FROM s CROSS JOIN LATERAL public.intercompany_mirror_facts(s.source_intercompany_id, s.period_end::DATE) x
       WHERE s.source_intercompany_id IS NOT NULL AND s.status IN ('draft', 'posted')
    ), fa AS (
      SELECT f.adj_id, json_agg(json_build_object('label', f.label, 'is_sum', f.is_sum, 'ord', f.ord, 'mirror_ref', f.mirror_ref, 'amount', f.amount,
                                                  'stands', f.stands, 'link', f.link, 'by_total', f.by_total, 'elim_date', to_char(f.elim_date, 'YYYY-MM-DD'),
                                                  'other_role', f.other_role, 'sender_cancelled', f.sender_cancelled, 'judged_at', to_char(f.judged_at, 'YYYY-MM-DD')) ORDER BY f.ord) AS mirror_facts,
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
 * from that row's mirror facts) unless `confirmDuplicate`: the person saw what is true and confirmed.
 */
export async function postEliminationAdjustment(adjustmentId: string, groupId: string, confirmDuplicate = false): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments ca SET status='posted', posted_at=NOW(), updated_at=NOW()
      WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.status='draft'
        AND (ca.source_intercompany_id IS NULL OR NOT public.intercompany_is_mirrored_row(ca.source_intercompany_id))   -- (a hidden draft of a mirrored row: never posted by id)
        AND (${confirmDuplicate}::BOOLEAN OR ca.source_intercompany_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.intercompany_mirrored_duplicate(ca.source_intercompany_id, ca.period_end::DATE)))
      RETURNING ca.id
    `) as DbRow[];
    if (result.length === 0) {
      const dup = (await sql`
        SELECT to_char(ca.period_end, 'YYYY-MM-DD') AS pe, ca.source_intercompany_id AS row_id, COALESCE(public.intercompany_is_mirrored_row(ca.source_intercompany_id), false) AS mirrored,
               (SELECT json_agg(to_jsonb(f) ORDER BY f.ord) FROM public.intercompany_mirror_facts(ca.source_intercompany_id, ca.period_end::DATE) f) AS facts,
               (SELECT to_char(pc.cutover, 'YYYY-MM-DD') FROM intercompany_transactions t JOIN public.intercompany_pair_cutovers(${groupId}::UUID) pc
                  ON pc.company_low_id = LEAST(t.source_company_id, t.target_company_id) AND pc.company_high_id = GREATEST(t.source_company_id, t.target_company_id)
                 WHERE t.id = ca.source_intercompany_id AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee') AND t.transaction_date >= pc.cutover) AS pair_cutover
          FROM consolidation_adjustments ca
         WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.status='draft' AND ca.source_intercompany_id IS NOT NULL
      `) as DbRow[] | undefined;
      if (Array.isArray(dup) && dup[0]?.mirrored === true) throw new EliminationMirroredRowUnsupportedError(String(dup[0].row_id));
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
