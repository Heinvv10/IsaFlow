/**
 * A manual elimination that RESOLVES a mirrored row no path eliminates (intercompany_mirror_unresolved): it carries the row
 * (consolidation_adjustments.source_intercompany_id). A person's elimination (it has a reason) and the derived one are mutually exclusive
 * (intercompany_row_manually_eliminated: the derivation emits nothing for a row a person has eliminated), so these checks are about telling the
 * person the truth, not about keeping the figures right. Before the insert (assertMirroredRowResolvable, under the group's elimination lock):
 * the row is a mirrored row of THIS group, the period lies in the row's month and holds its date, no draft or posted elimination of a person
 * stands for it, and it is listed as unresolved for that period. Before the post (eliminationDuplicates.ts postEliminationAdjustment, in the same UPDATE): it still is
 * (the receiver may have accepted and approved since). An older generator's adjustment (no reason) is ignored everywhere for a mirrored row.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { EliminationAlreadyStandsError, EliminationNotUnresolvedError, EliminationSourceError } from './eliminationErrors';
import { lockGroupEliminations } from './eliminationLock';

export async function assertMirroredRowResolvable(groupId: string, rowId: string, periodStart: string, periodEnd: string): Promise<void> {
  const rows = (await sql`
    SELECT it.transaction_date::TEXT AS td FROM intercompany_transactions it
     WHERE it.id = ${rowId}::UUID AND it.group_id = ${groupId}::UUID AND public.intercompany_is_mirrored_row(it.id)
  `) as DbRow[];
  if (!rows[0]) throw new EliminationSourceError(rowId, 'it is not an intercompany row of this group that a mirrored document records');
  const td = String(rows[0].td);
  if (!periodStart || !periodEnd) throw new EliminationSourceError(rowId, 'it needs both a period start and a period end');
  if (periodStart.slice(0, 7) !== td.slice(0, 7) || periodEnd.slice(0, 7) !== td.slice(0, 7)) {
    throw new EliminationSourceError(rowId, `the elimination's period ${periodStart} to ${periodEnd} must lie within the month of the row's date ${td}`);
  }
  if (td < periodStart || td > periodEnd) throw new EliminationSourceError(rowId, `it is dated ${td}, outside the elimination's period ${periodStart} to ${periodEnd}`);
  await lockGroupEliminations(groupId, 'assertMirroredRowResolvable');
  const stands = (await sql`
    SELECT 1 FROM consolidation_adjustments ca WHERE ca.source_intercompany_id = ${rowId}::UUID AND ca.group_id = ${groupId}::UUID
       AND ca.status IN ('draft', 'posted') AND ca.manual_reason IS NOT NULL LIMIT 1
  `) as DbRow[];
  if (stands.length > 0) throw new EliminationAlreadyStandsError(rowId);
  const listed = (await sql`
    SELECT 1 FROM public.intercompany_mirror_unresolved(${groupId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE) u WHERE u.transaction_id = ${rowId}::UUID
  `) as DbRow[];
  if (listed.length === 0) throw new EliminationNotUnresolvedError(rowId, `${periodStart} to ${periodEnd}`);
}
