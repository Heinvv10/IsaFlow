/**
 * The dry run's item outcomes against the snapshot the plan was made from. PURE.
 *
 * The plan refuses every item row whose code an item the migration does not own holds, from the snapshot read BEFORE the dry run.
 * bulk_upsert_items matches by Sage reference and then by CODE and updates what it matches, so a writer that adds such an item
 * between that read and the dry run would be overwritten by the live run. The dry run writes live (inside a transaction that is
 * rolled back), so its answer says what the live call would do: a row that comes back `updated` / `unchanged` for a Sage id the
 * snapshot did not show as owned (or `created` for one it did) means the books changed under the plan, and the dry run fails with
 * the row named. What remains is the window between the dry run and the live batch: a named limit.
 */
import type { BatchReport } from './sageMigrationTypes';
import type { ExistingItem } from './sageSnapshot';

export interface PlannedItemRef { sageId: string; code: string }

interface ItemAnswer { index?: unknown; outcome?: unknown }

export function ownershipProblem(b: BatchReport, rows: readonly PlannedItemRef[], before: { items: readonly ExistingItem[] }): string | null {
  for (const a of (b.toolReported?.rows ?? []) as ItemAnswer[]) {
    const row = rows[Number(a.index)];
    if (!row) continue;
    const owned = before.items.some((i) => i.system === 'sage' && i.ref === row.sageId && !i.deleted);
    const label = `row ${String(a.index)} (${row.code}, Sage id ${row.sageId})`;
    if ((a.outcome === 'updated' || a.outcome === 'unchanged') && !owned) {
      return `${label} came back ${String(a.outcome)}, but it is not an item this migration owns: an item with that code or reference appeared since the snapshot the plan was made from (another writer). Nothing is written; run again.`;
    }
    if (a.outcome === 'created' && owned) {
      return `${label} came back created, but the snapshot shows the migration already owns that Sage id: the books changed since the snapshot. Nothing is written; run again.`;
    }
  }
  return null;
}
