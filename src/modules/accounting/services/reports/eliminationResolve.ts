/**
 * A manual elimination that RESOLVES a mirrored row no path eliminates (intercompany_mirror_unresolved): it carries the row
 * (consolidation_adjustments.source_intercompany_id), so the row stops being listed once it is posted and a second person is not told to make
 * another. This is the check the route makes before it creates one: the row is a mirrored row of THIS group dated inside the elimination's
 * period, and no draft or posted elimination of it stands (reverse that one first). The partial unique index (1019) is the race-proof half
 * (a 23505 mapped to the same error); where legacy duplicates kept 1019 from building it, this check is the only one.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { EliminationAlreadyStandsError, EliminationSourceError } from './eliminationErrors';

export async function assertMirroredRowResolvable(groupId: string, rowId: string, periodStart: string, periodEnd: string): Promise<void> {
  const rows = (await sql`
    SELECT it.transaction_date::TEXT AS td,
           EXISTS (SELECT 1 FROM consolidation_adjustments ca WHERE ca.source_intercompany_id = it.id AND ca.group_id = ${groupId}::UUID
                    AND ca.status IN ('draft', 'posted')) AS stands
      FROM intercompany_transactions it
     WHERE it.id = ${rowId}::UUID AND it.group_id = ${groupId}::UUID AND public.intercompany_is_mirrored_row(it.id)
  `) as DbRow[];
  const row = rows[0];
  if (!row) throw new EliminationSourceError(rowId, 'it is not an intercompany row of this group that a mirrored document records');
  if (String(row.td) < periodStart || String(row.td) > periodEnd) {
    throw new EliminationSourceError(rowId, `it is dated ${String(row.td)}, outside the elimination's period ${periodStart} to ${periodEnd}`);
  }
  if (row.stands) throw new EliminationAlreadyStandsError(rowId);
}
