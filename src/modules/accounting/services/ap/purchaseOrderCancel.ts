/**
 * Cancelling an APPROVED purchase order (budgets P5-3 review r2; breaker REPRO 2, coordinator ruling, Hein may
 * override). Without it an approved PO's commitment could never leave remaining: the PUT edits only draft/submitted
 * orders. Cancelled is not a committing status (`remainingCommitted.COMMITTING_PO_STATUSES`), so the commitment is
 * released the moment this commits. Draft and submitted orders are still cancelled through the PUT.
 *
 * Allowed only while NO goods have been received: status still `approved` AND no goods_received_notes row for the
 * PO (a receipt that only rejected goods leaves the status `approved` but is still a receipt). `partially_received`
 * and `received` stay uncancellable: goods are in hand, the received part is owed to the supplier and awaits its
 * bill, so releasing the commitment would understate spend, and the receipts (grn_items, quantity_received) would
 * stand against a cancelled order. Owner/admin only (`@/lib/auth/writeRoles` PO_CANCEL_ROLES, the route), with a
 * mandatory reason, audited.
 *
 * Refused while any bill is linked to it (migration 1006; brief section 4): the commitment it releases is what those bills billed.
 * `via` (the MCP tool's name) is recorded as the audit row's `source`.
 * A link on a cancelled bill bills nothing and does not count (a cancel is terminal), so the app's own bill cancel frees
 * the PO; no MCP-only unlink is needed. A soft-deleted bill still counts: it can be restored, live and linked.
 * Locks: the PO row `FOR UPDATE` only (no budget lock: releasing a commitment cannot overspend). The goods receipt
 * takes its number lock (620) then the same PO row, and re-checks the status under it, so cancel and receipt
 * serialise on the row and exactly one wins. All in one savepoint; every refusal comes before the write.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '../core/auditTrailService';
import { tieRefusalText } from './purchaseOrderTies';
import {
  lockPurchaseOrder, PurchaseOrderChangedError, PurchaseOrderNotCancellableError, PurchaseOrderNotFoundError,
} from './purchaseOrderErrors';

export { PurchaseOrderNotCancellableError } from './purchaseOrderErrors';

export async function cancelApprovedPurchaseOrder(companyId: string, poId: string, userId: string, reason: string, via?: string): Promise<DbRow> {
  const why = reason.trim();
  if (why === '') throw new PurchaseOrderNotCancellableError('Give a reason to cancel an approved purchase order');
  await assertNotImpersonating();
  return withSavepoint('cancel_purchase_order', async () => {
    const po = await lockPurchaseOrder(companyId, poId);
    if (!po) throw new PurchaseOrderNotFoundError();
    if (po.status === 'partially_received' || po.status === 'received') {
      throw new PurchaseOrderNotCancellableError(`Goods have been received against this purchase order (it is ${po.status.replace(/_/g, ' ')}), so it cannot be cancelled`);
    }
    if (po.status !== 'approved') {
      throw new PurchaseOrderNotCancellableError(`Only an approved purchase order is cancelled here (this one is ${po.status}); edit a draft or submitted one to cancel it`);
    }
    const linked = (await sql`
      SELECT 1 FROM purchase_order_bill_links l
        JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
       WHERE l.purchase_order_id = ${poId}::UUID AND l.company_id = ${companyId}::UUID
         AND si.status <> 'cancelled'
       LIMIT 1
    `) as DbRow[];
    if (linked.length > 0) {
      throw new PurchaseOrderNotCancellableError(await tieRefusalText(companyId, poId, 'it cannot be cancelled', ['link'], { liveBillLinksOnly: true }) ?? 'A bill is linked to this purchase order, so it cannot be cancelled; unlink it first (unlink_bill_from_purchase_order)');
    }
    const receipts = (await sql`
      SELECT 1 FROM goods_received_notes WHERE purchase_order_id = ${poId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
    `) as DbRow[];
    if (receipts.length > 0) {
      throw new PurchaseOrderNotCancellableError('Goods have been received against this purchase order (a receipt is on record), so it cannot be cancelled');
    }
    const updated = (await sql`
      UPDATE purchase_orders SET status = 'cancelled', updated_at = NOW(), updated_by = ${userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = 'approved'
      RETURNING *
    `) as DbRow[];
    if (!updated[0]) throw new PurchaseOrderChangedError();
    await logAuditOrThrow({
      companyId, userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: po.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: 'approved', new: 'cancelled', label: 'Status' }],
        metadata: { cancelled: 'true', reason: why, ...(via ? { source: via } : {}) },
      },
    });
    return updated[0];
  });
}
