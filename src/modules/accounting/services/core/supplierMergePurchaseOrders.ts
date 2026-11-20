/**
 * The purchase orders of a supplier being merged away (#1655 review). A merge moves them to the survivor, and a supplier
 * change on a purchase order is controlled in `updatePurchaseOrder`: editing an APPROVED PO is owner / admin only
 * (`canCancelApprovedPo`, refusal text `APPROVED_EDIT_REFUSAL`), the edit restamps approved_by / approved_at to the editor
 * (the previous approver is kept in the audit row), and an `update` audit row records the supplier_id change. A merge must not
 * be a way round those, so it shares them:
 *
 * - LOCK ORDER (ap/.claude.md, the PO <-> bill census): the source's PO rows are locked FOR NO KEY UPDATE, id order, first of
 *   all, then the payments and bills. That is the link / unlink order (PO NO KEY UPDATE -> bills, purchaseOrderBillLinkRead),
 *   and NO KEY UPDATE does not conflict with the KEY SHARE a bill write takes on its PO (the app sync: bill -> PO FOR KEY
 *   SHARE), so a bill writer and a merge never wait on each other in a cycle. FOR UPDATE would conflict with that KEY SHARE
 *   (the inversion). The lock comes BEFORE the bill-link check, so a link made meanwhile (its maker holds the PO) is waited
 *   for and seen; the lock is held to the end of the transaction, so no link or approval can appear on a PO being moved.
 *   Waited at most 5 s (`withRowLockBudget`, `PurchaseOrderLockTimeoutError`, a 503 retry).
 * - a PO past draft / submitted (approved, partially received, received, closed) moves only for a role that passes
 *   `canCancelApprovedPo`; otherwise the merge is refused (`purchaseOrderMoveRefusal`, thrown by the caller as a
 *   SupplierMergeRefusal) before anything moves. A cancelled PO commits nothing and moves for anyone. Unlike
 *   `updatePurchaseOrder`, which refuses a received or closed PO outright, a merge moves those too: leaving them on the deleted
 *   supplier would strand them;
 * - each moved PO gets the same `update` audit row (`entityType purchase_order`, a `supplier_id` field change). Approved_by is
 *   restamped only for an APPROVED PO, as `updatePurchaseOrder` does (the only status it edits past submitted); a part-received
 *   or received PO keeps its approver, and every PO past submitted records the prior approver in the audit metadata.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { logAuditOrThrow } from './auditTrailService';
import { withRowLockBudget } from './rowLockBudget';
import { APPROVED_EDIT_REFUSAL } from '../ap/purchaseOrderUpdate';
import { PurchaseOrderLockTimeoutError } from '../ap/purchaseOrderErrors';

export interface SourcePo { id: string; poNumber: string; status: string; approvedBy: string | null; approvedAt: string | null }

export interface PoMoveActor { userId: string; role: string | null | undefined; via: string }

/** Statuses a PO's supplier may change in without the approved-edit permission (a cancelled PO commits nothing). */
const OPEN_PO_STATUSES: readonly string[] = ['draft', 'submitted', 'cancelled'];

/** The supplier's purchase orders, locked FOR NO KEY UPDATE (company-scoped, in id order so two merges lock alike). */
export async function lockSupplierPurchaseOrders(companyId: string, supplierId: string): Promise<SourcePo[]> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT id::TEXT AS id, po_number, status, approved_by, approved_at::TEXT AS approved_at
      FROM purchase_orders WHERE supplier_id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
     ORDER BY id
       FOR NO KEY UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError());
  return rows.map((r) => ({
    id: String(r.id), poNumber: String(r.po_number), status: String(r.status),
    approvedBy: r.approved_by == null ? null : String(r.approved_by), approvedAt: r.approved_at == null ? null : String(r.approved_at),
  }));
}

/** The reason this actor may not merge the POs away, or null. Nothing has moved when it answers. */
export function purchaseOrderMoveRefusal(pos: readonly SourcePo[], role: string | null | undefined): string | null {
  if (canCancelApprovedPo(role) || !pos.some((p) => !OPEN_PO_STATUSES.includes(p.status))) return null;
  return `This supplier has approved, partly received or received purchase orders, and merging moves them to the other supplier. ${APPROVED_EDIT_REFUSAL}.`;
}

/** Moves the (locked) purchase orders to the survivor, one audit row each. Returns how many actually moved. */
export async function movePurchaseOrders(
  companyId: string, pos: readonly SourcePo[], fromId: string, toId: string, actor: PoMoveActor,
): Promise<number> {
  let count = 0;
  for (const po of pos) {
    const approved = po.status === 'approved';
    const moved = (await sql`
      UPDATE purchase_orders SET
        supplier_id = ${toId}::UUID,
        approved_by = CASE WHEN ${approved}::BOOLEAN THEN ${actor.userId}::TEXT ELSE approved_by END,
        approved_at = CASE WHEN ${approved}::BOOLEAN THEN NOW() ELSE approved_at END,
        updated_at = NOW(), updated_by = ${actor.userId}
      WHERE id = ${po.id}::UUID AND company_id = ${companyId}::UUID AND supplier_id = ${fromId}::UUID
      RETURNING id
    `) as DbRow[];
    if (!moved[0]) continue;
    count += 1;
    const pastSubmitted = po.status !== 'draft' && po.status !== 'submitted' && po.status !== 'cancelled';
    await logAuditOrThrow({
      companyId, userId: actor.userId, action: 'update', entityType: 'purchase_order', entityId: po.id, entityRef: po.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'supplier_id', old: fromId, new: toId, label: 'Supplier' }],
        metadata: {
          source: actor.via, status: po.status, changed: 'supplier_id',
          ...(pastSubmitted ? { prior_approved_by: po.approvedBy ?? '', prior_approved_at: po.approvedAt ?? '' } : {}),
        },
      },
    });
  }
  return count;
}
