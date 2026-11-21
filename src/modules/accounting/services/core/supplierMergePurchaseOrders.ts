/**
 * The purchase orders of a supplier being merged away (#1655 review). A merge moves them to the survivor, and a supplier
 * change on a purchase order is controlled in `updatePurchaseOrder`: editing an APPROVED PO is owner / admin only
 * (`canCancelApprovedPo`, refusal text `APPROVED_EDIT_REFUSAL`), the edit restamps approved_by / approved_at to the editor
 * (the previous approver is kept in the audit row), and an `update` audit row records the supplier_id change. A merge must not
 * be a way round those, so it shares them:
 *
 * - LOCK, FOR UPDATE (not NO KEY UPDATE): the source's PO rows are locked FOR UPDATE, id order, first of all, then the
 *   payments and bills. A bill create (`recordBillLinks`, ap/billPurchaseOrderLinks) takes FOR KEY SHARE on the PO it links, and
 *   a FOR NO KEY UPDATE lock does not conflict with that: a bill still uncommitted on the source could link to a PO the merge
 *   moves, leaving a link across two suppliers, which migration 1006 says must never exist (the guard cannot see the uncommitted
 *   link). FOR UPDATE does conflict with it, so the merge waits for that bill, then sees its link and refuses; and a bill create
 *   that arrives later waits for the merge, then finds the PO on the other supplier and links nothing. The lock comes BEFORE the
 *   bill-link check for the same reason. Cost: a contention window against bill creates, answered, never faulted: waited at most
 *   5 s (`withRowLockBudget`, `PurchaseOrderLockTimeoutError`) and a deadlock victim (40P01) is the same retryable 503 on both
 *   routes (`respondIfLockTimeout`). Both sides take POs in id order, so two POs cannot cycle. KNOWN CYCLE, ACCEPTED: a draft
 *   bill edit takes the bill row (UPDATE) and then the PO FOR KEY SHARE (`refreshAppBillLinks`); the merge takes the PO FOR
 *   UPDATE and then updates the bills. When both touch the same bill and PO each waits for the other, and Postgres kills one with
 *   40P01: a retryable 503 for the merge (or the edit), nothing written, no corruption (the link guard and the lock both hold).
 *   It is rare (a merge of that supplier at the instant of an edit of one of its bills) and a merge is retried by hand. The
 *   alternative orders were weighed and rejected: bills first lets a link made meanwhile reach a bill the merge already moved
 *   (23514 from the database guard instead of the clean refusal), and FOR NO KEY UPDATE lets a bill edit link to a PO being moved.
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
import { SupplierMergeRefusal } from './supplierMergeRefusal';

/** Shown when a supplier merge is refused because the source has purchase-order <-> bill links (mig 1006). */
export const PO_BILL_LINKS_REFUSAL =
  'This supplier has bills linked to purchase orders. Unlink them (unlink_bill_from_purchase_order) before merging, so no link joins two suppliers.';

export interface SourcePo { id: string; poNumber: string; status: string; approvedBy: string | null; approvedAt: string | null }

export interface PoMoveActor { userId: string; role: string | null | undefined; via: string }

/** Statuses a PO's supplier may change in without the approved-edit permission (a cancelled PO commits nothing). */
const OPEN_PO_STATUSES: readonly string[] = ['draft', 'submitted', 'cancelled'];

/** The supplier's purchase orders, locked FOR UPDATE (company-scoped, in id order so two merges lock alike). */
export async function lockSupplierPurchaseOrders(companyId: string, supplierId: string): Promise<SourcePo[]> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT id::TEXT AS id, po_number, status, approved_by, approved_at::TEXT AS approved_at
      FROM purchase_orders WHERE supplier_id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
     ORDER BY id
       FOR UPDATE
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

/**
 * Both merge paths, before anything moves: the source's POs locked first, so a bill link made meanwhile cannot slip past the link
 * check (a link maker locks the PO too). Migration 1006: a purchase order <-> bill link joins one supplier's documents, and the
 * database refuses a supplier change on a PO or bill that has one; refuse with the reason. Then the approved-PO role check.
 */
export async function lockMovablePurchaseOrders(companyId: string, sourceId: string, role: string | null | undefined): Promise<SourcePo[]> {
  const pos = await lockSupplierPurchaseOrders(companyId, sourceId);
  const linked = await sql`
    SELECT 1 FROM purchase_order_bill_links l
      JOIN purchase_orders po ON po.id = l.purchase_order_id AND po.company_id = l.company_id
     WHERE l.company_id = ${companyId}::UUID AND po.supplier_id = ${sourceId}::UUID LIMIT 1
  `;
  if (linked.length > 0) throw new SupplierMergeRefusal(PO_BILL_LINKS_REFUSAL);
  const refusal = purchaseOrderMoveRefusal(pos, role);
  if (refusal) throw new SupplierMergeRefusal(refusal);
  return pos;
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
