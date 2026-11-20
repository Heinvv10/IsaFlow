/**
 * A supplier merge never moves an approved purchase order (#1699 review). supplier_id is part of what an approval
 * approved: editing it on an approved PO is owner / admin only and restamps the approver (purchaseOrderUpdate), so a
 * merge must not carry one across with its old approval attached.
 *
 * Both merge paths call this before anything moves. It locks every PO of the source (FOR UPDATE, ordered by id, under
 * the row-lock budget) and then judges them, so a PO approved by a concurrent request either commits first (and is
 * seen here) or waits for the merge (and is approved on the survivor, as it then reads). The refusal comes before any
 * write because the duplicates-merge route runs on the request transaction, which commits on a 400.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from './rowLockBudget';
import { SupplierMergeRefusal } from './duplicateMergeService';

export const APPROVED_PO_REFUSAL =
  'This supplier has approved purchase orders. An owner or admin moves each to the other supplier (update_purchase_order) before merging, so each keeps a valid approval.';

/** PO statuses that carry an approval; a PO with an approver on record counts too, unless cancelled. */
export const APPROVED_PO_STATUSES: readonly string[] = ['approved', 'partially_received', 'received', 'closed'];

export async function assertSupplierMergeMovesNoApprovedPo(companyId: string, sourceId: string): Promise<void> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT status, approved_by FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
     ORDER BY id FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('A purchase order of this supplier'));
  const approved = rows.some((r) => APPROVED_PO_STATUSES.includes(String(r.status))
    || (r.approved_by != null && r.status !== 'cancelled'));
  if (approved) throw new SupplierMergeRefusal(APPROVED_PO_REFUSAL);
}
