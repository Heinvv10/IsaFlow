/**
 * "Closed because fully billed" (PR #1703, ledger breaker r4 R4-1): the record lives on the purchase order itself,
 * `purchase_orders.closed_by_billing` beside `closed_from_status` (migration 1022), never on a link. Only the link tool's
 * close_when_fully_billed and 1022's close step set it; a manual short close (close_purchase_order) and set_purchase_order_status
 * leave it false, and 1022's trigger clears it whenever the status leaves closed, whoever writes that.
 *
 * The one rule (`isClosedUnderBilled`, also get_purchase_order's closed_under_billed): closed, closed_by_billing, and no longer
 * fully billed (`purchaseOrderBilled.billedCentsByPo` < subtotal - 1 c). `reopenUnderBilled` re-judges POs after a counted tie
 * went (billed fell: the unlink of a billed live bill's link / lines / header, a bill cancelled or soft-deleted) and reopens each
 * to closed_from_status, clearing both columns, with an audit row. A PO whose billed did not fall is never reopened: removing a
 * tie that never counted (a draft or cancelled bill's) leaves a PO closed under-billed as it was (review r4 L2).
 *
 * Lock order: the caller holds the PO rows (FOR NO KEY UPDATE) BEFORE any bill row, as the link and unlink do:
 * `lockPosClosedByBilling` is that step for the bill cancel and the bill soft delete (PO -> bill, the census in
 * docs/design/mcp-po-bill-links.md).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { toCents } from '../budgets/grid/cents';
import { billedCentsByPo } from './purchaseOrderBilled';
import { isFullyBilled } from './purchaseOrderBillLinkTypes';

export interface BillingClosedPo { poId: string; poNumber: string; status: string; closedByBilling: boolean; subtotalCents: number }

/** The one rule: a PO closed because it was fully billed that no longer is. */
export function isClosedUnderBilled(po: { status: string; closedByBilling: boolean; subtotalCents: number }, billedCents: number): boolean {
  return po.status === 'closed' && po.closedByBilling && !isFullyBilled(billedCents, po.subtotalCents);
}

/**
 * The POs closed by billing that this bill ties (a link, its header, a line naming one of their lines), locked FOR NO KEY UPDATE in id
 * order, and what each is billed now: taken BEFORE the bill is locked (PO -> bill). A tie written after this read is on a PO this call
 * does not re-judge; its own writer (the link) locked that PO first.
 */
export async function lockPosClosedByBilling(companyId: string, billId: string): Promise<Map<string, number>> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT po.id::TEXT AS id FROM purchase_orders po
     WHERE po.company_id = ${companyId}::UUID AND po.status = 'closed' AND po.closed_by_billing
       AND po.id IN (
         SELECT l.purchase_order_id FROM purchase_order_bill_links l WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = ${billId}::UUID
         UNION SELECT si.purchase_order_id FROM supplier_invoices si WHERE si.company_id = ${companyId}::UUID AND si.id = ${billId}::UUID
         UNION SELECT pi.purchase_order_id FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id WHERE x.supplier_invoice_id = ${billId}::UUID)
     ORDER BY po.id FOR NO KEY UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('A purchase order of this bill'));
  const ids = rows.map((r) => String(r.id).toLowerCase());
  const billed = await billedCentsByPo(companyId, ids);
  return new Map(ids.map((id) => [id, billed.get(id) ?? 0]));
}

/**
 * Re-judge POs whose billed may have fallen (`billedBefore`: what each was billed before the change, read under the caller's PO lock).
 * Reopens each that is closed by billing, billed less than before, and no longer fully billed. Returns poId -> the status it reopened to.
 */
export async function reopenUnderBilled(
  companyId: string, billedBefore: ReadonlyMap<string, number>,
  opts: { userId: string; via: string; why: string; /** false: the caller's own audit row records the reopen (the unlink). */ audit?: boolean },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...billedBefore.keys()];
  if (ids.length === 0) return out;
  const pos = (await sql`
    SELECT id::TEXT AS id, po_number, status, closed_by_billing, closed_from_status, subtotal::TEXT AS subtotal FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND status = 'closed' AND closed_by_billing
  `) as DbRow[];
  const billed = await billedCentsByPo(companyId, pos.map((p) => String(p.id).toLowerCase()));
  for (const p of pos) {
    const id = String(p.id).toLowerCase();
    const now = billed.get(id) ?? 0;
    const facts = { status: 'closed', closedByBilling: true, subtotalCents: toCents(Number(p.subtotal ?? 0)) };
    if (!(now < (billedBefore.get(id) ?? 0)) || !isClosedUnderBilled(facts, now) || p.closed_from_status == null) continue;
    const to = String(p.closed_from_status);
    const back = (await sql`
      UPDATE purchase_orders SET status = ${to}, closed_from_status = NULL, closed_by_billing = false, updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'closed' AND closed_by_billing RETURNING id
    `) as DbRow[];
    if (back.length !== 1) throw new Error('The purchase order changed while it was being reopened');
    out.set(id, to);
    if (opts.audit === false) continue;
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'purchase_order', entityId: id, entityRef: String(p.po_number).slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: 'closed', new: to, label: 'Status' }],
        metadata: { reopened: 'true', reason: opts.why.slice(0, 500), source: opts.via, billed: (now / 100).toFixed(2), subtotal: (facts.subtotalCents / 100).toFixed(2) },
      },
    });
  }
  return out;
}
