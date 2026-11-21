/**
 * Stored eliminations against the mirrored documents (whose eliminations are derived, mirrorEliminations.ts).
 *
 * RULING 2026-11-21 (Hein), the per-pair cutover: from the date both companies of a pair have mirroring on (intercompany_pair_cutovers), the
 * pair's invoices and credit notes are eliminated by mirroring only. The generator drafts nothing for the pair's sale-class rows dated on or
 * after it (eliminationGenerator.ts), and a hand-made elimination dated on or after a cutover of the group needs a typed reason (below).
 *
 * Before the cutover a manual row can still be the same sale as a mirror (a document dated after the connection's cut-over date but approved
 * once both sides were on is mirrored): intercompany_mirrored_duplicate flags it, the list warns with whether the mirror is eliminated
 * automatically (intercompany_mirror_stands, once per distinct mirror), and posting a matching draft needs the person's confirm.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { EliminationPossibleDuplicateError, EliminationStateError } from './eliminationErrors';

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
 * The stored adjustments of the list, each with its possible mirrored duplicate (draft or posted; among several candidates, the closest eliminated
 * automatically for the adjustment's period), whether that is eliminated automatically for that period, whether another row's active link holds
 * it, and how many listed adjustments point at the same mirror(s).
 */
export async function storedEliminationRows(groupId: string, pStart: string | null, pEnd: string | null): Promise<DbRow[]> {
  return (await sql`
    WITH pc AS MATERIALIZED (SELECT * FROM public.intercompany_pair_cutovers(${groupId}::UUID)
    ), s AS MATERIALIZED (
      SELECT ca.*, dup.mirror_rows, dup.mirror_ref,
             -- another row's active link holds the mirror (the only case the list may say it "was matched to a different row")
             CASE WHEN dup.mirror_rows IS NOT NULL THEN (SELECT EXISTS (SELECT 1 FROM intercompany_transactions t JOIN intercompany_mirror_links l ON l.mirror_row = ANY (dup.mirror_rows) AND l.released_at IS NULL AND l.row_id <> t.id
                                 AND l.role = CASE WHEN t.transaction_type = 'purchase' THEN 'purchase' ELSE 'sale' END
                WHERE t.id = ca.source_intercompany_id)) END AS mirror_linked,
             -- the row is on or after its pair's cutover (sale class): it was drafted because no standing mirror is left to it
             (SELECT pc.cutover::TEXT FROM intercompany_transactions t JOIN pc
                ON pc.company_low_id = LEAST(t.source_company_id, t.target_company_id) AND pc.company_high_id = GREATEST(t.source_company_id, t.target_company_id)
               WHERE t.id = ca.source_intercompany_id AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee') AND t.transaction_date >= pc.cutover) AS pair_cutover
        FROM consolidation_adjustments ca
        LEFT JOIN LATERAL public.intercompany_mirrored_duplicate(ca.source_intercompany_id, ca.period_end::DATE) dup
          ON ca.source_intercompany_id IS NOT NULL AND ca.status IN ('draft', 'posted')
       WHERE ca.group_id = ${groupId}::UUID
         -- a stored adjustment of a MIRRORED row (written by an older generator, e.g. after a code rollback) is never shown: its figure is derived
         AND (ca.source_intercompany_id IS NULL OR NOT public.intercompany_is_mirrored_row(ca.source_intercompany_id))
         AND (${pStart}::DATE IS NULL OR ca.period_start >= ${pStart}::DATE)
         AND (${pEnd}::DATE IS NULL OR ca.period_end <= ${pEnd}::DATE)
    ), st AS MATERIALIZED (
      -- each distinct (mirror, period end) judged ONCE, however many adjustments point at it: eliminated automatically FOR THAT PERIOD
      SELECT x.id, x.pe, COALESCE(public.intercompany_mirror_stands(x.id, x.pe), false) AS stands
        FROM (SELECT DISTINCT unnest(s.mirror_rows) AS id, s.period_end::DATE AS pe FROM s WHERE s.mirror_rows IS NOT NULL) x
    )
    SELECT s.*, s.mirror_ref AS mirrored_duplicate_of,
           CASE WHEN s.mirror_rows IS NOT NULL THEN (SELECT bool_and(st.stands) FROM st WHERE st.id = ANY (s.mirror_rows) AND st.pe IS NOT DISTINCT FROM s.period_end::DATE) END AS mirror_stands,
           CASE WHEN s.mirror_rows IS NOT NULL THEN count(*) OVER (PARTITION BY s.mirror_rows) END AS mirror_shared
      FROM s
     ORDER BY s.created_at DESC
  `) as DbRow[];
}

/**
 * Posts a draft. A draft whose row may be the same sale as a live mirrored document is refused (EliminationPossibleDuplicateError, saying
 * whether that mirror is eliminated automatically) unless `confirmDuplicate`: the person saw what is true and confirmed.
 */
export async function postEliminationAdjustment(adjustmentId: string, groupId: string, confirmDuplicate = false): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments ca SET status='posted', posted_at=NOW(), updated_at=NOW()
      WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.status='draft'
        AND (${confirmDuplicate}::BOOLEAN OR ca.source_intercompany_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.intercompany_mirrored_duplicate(ca.source_intercompany_id, ca.period_end::DATE)))
      RETURNING ca.id
    `) as DbRow[];
    if (result.length === 0) {
      const dup = (await sql`
        SELECT d.mirror_ref, (SELECT bool_and(COALESCE(public.intercompany_mirror_stands(x, ca.period_end::DATE), false)) FROM unnest(d.mirror_rows) x) AS stands,
               (SELECT pc.cutover::TEXT FROM intercompany_transactions t JOIN public.intercompany_pair_cutovers(${groupId}::UUID) pc
                  ON pc.company_low_id = LEAST(t.source_company_id, t.target_company_id) AND pc.company_high_id = GREATEST(t.source_company_id, t.target_company_id)
                 WHERE t.id = ca.source_intercompany_id AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee') AND t.transaction_date >= pc.cutover) AS pair_cutover,
               (SELECT EXISTS (SELECT 1 FROM intercompany_transactions t JOIN intercompany_mirror_links l ON l.mirror_row = ANY (d.mirror_rows) AND l.released_at IS NULL AND l.row_id <> t.id
                                 AND l.role = CASE WHEN t.transaction_type = 'purchase' THEN 'purchase' ELSE 'sale' END
                WHERE t.id = ca.source_intercompany_id)) AS linked
          FROM consolidation_adjustments ca CROSS JOIN LATERAL public.intercompany_mirrored_duplicate(ca.source_intercompany_id, ca.period_end::DATE) d
         WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.status='draft' AND ca.source_intercompany_id IS NOT NULL
      `) as DbRow[] | undefined;
      if (!confirmDuplicate && Array.isArray(dup) && dup.length > 0) {
        const d = dup[0]!;
        throw new EliminationPossibleDuplicateError(adjustmentId, String(d.mirror_ref), d.stands === true, d.pair_cutover ? String(d.pair_cutover) : null, d.linked === true);
      }
      throw new EliminationStateError(adjustmentId, 'draft');
    }
    log.info('Posted elimination adjustment', { adjustmentId, groupId, confirmDuplicate }, 'accounting');
  } catch (err) {
    log.error('Failed to post elimination adjustment', { adjustmentId, groupId, error: err }, 'accounting');
    throw err;
  }
}
