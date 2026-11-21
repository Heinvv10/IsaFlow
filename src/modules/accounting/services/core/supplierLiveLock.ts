/**
 * The supplier a writer is about to file a bill under, locked and checked live (#1699 review, findings 3 and 4).
 *
 * A supplier merge holds both supplier rows FOR UPDATE while it moves the source's bills, then soft-deletes the source
 * (merged_into_id). A writer that chose its supplier from an earlier read (the AP take-on's batch list, the Sage bill import's
 * party match) could otherwise check for a duplicate on the source after the merge moved the bill away, or file onto a row the
 * merge has just deleted. Taking the row FOR KEY SHARE first makes the writer wait for a merge in progress and keeps any later merge
 * of that row waiting until the writer's transaction ends; the check after the wait sees the merge's outcome.
 *
 * FOR KEY SHARE is what the bill INSERT's foreign key takes on the same row anyway, so this moves that lock earlier in the writer's
 * transaction; it adds no new lock. Lock order: the supplier row before any bill, PO or journal row the writer touches, which is the
 * merge's order too (supplier rows FOR UPDATE first, then POs, payments, bills). A writer that holds several suppliers (a batch
 * import) and a merge of two of them can still meet in opposite orders; Postgres ends one with 40P01 and nothing is written. The
 * same pair already met at the INSERT's foreign key before this lock existed. Each wait is bounded (withRowLockBudget, 5 s, a typed
 * retryable RowLockTimeoutError), as the merge's own supplier lock is.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ROW_LOCK_BUDGET_MS, RowLockTimeoutError, withRowLockBudget } from './rowLockBudget';

/** How many merges (A into B, B into C, ...) lockLiveSurvivor follows. */
export const MAX_SURVIVOR_HOPS = 10;

const timeout = () => new RowLockTimeoutError('A supplier being merged');

/** True when the supplier is live; it then stays live and unmerged until the caller's transaction ends. */
export async function lockSupplierIfLive(companyId: string, supplierId: string): Promise<boolean> {
  // After a wait the row is re-read: a merge that committed meanwhile set deleted_at, and the row no longer qualifies.
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT id FROM suppliers
     WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
       FOR KEY SHARE
  `) as DbRow[], timeout);
  return rows.length > 0;
}

/**
 * The live supplier at the end of `supplierId`'s merge chain, locked FOR KEY SHARE (the row itself when it is live). Null when the
 * chain ends on a row deleted without a survivor, leaves the company, revisits a row or is longer than MAX_SURVIVOR_HOPS.
 */
export async function lockLiveSurvivor(companyId: string, supplierId: string): Promise<string | null> {
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  const seen = new Set<string>();
  let id = supplierId;
  for (let hop = 0; hop <= MAX_SURVIVOR_HOPS && !seen.has(id); hop++) {
    seen.add(id);
    const rows = await withRowLockBudget(async () => (await sql`
      SELECT deleted_at IS NULL AS live, merged_into_id::TEXT AS merged_into_id FROM suppliers
       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
         FOR KEY SHARE
    `) as DbRow[], timeout, { deadline });
    const row = rows[0];
    if (!row) return null;
    if (row.live === true) return id;
    if (row.merged_into_id == null) return null;
    id = String(row.merged_into_id);
  }
  return null;
}
