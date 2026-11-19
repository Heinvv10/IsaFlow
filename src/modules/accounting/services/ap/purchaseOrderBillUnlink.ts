/**
 * unlink_bill_from_purchase_order (design decision 10). Under the same locks as the link (PO row, then bill row,
 * one 5 s budget): delete the link, clear `po_item_id` on the bill's lines that point into this PO, reset the bill's
 * header column (`purchaseOrderBillLinkHeader`) and, when this link's call closed the PO and it is still closed,
 * reopen it to the status it came from. A reason is required; audited (entity purchase_order). Posts nothing.
 * Every refusal comes before the first write. A cancelled or soft-deleted bill can still be unlinked (clean-up).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { RowLockTimeoutError, ROW_LOCK_BUDGET_MS, withRowLockBudget } from '../core/rowLockBudget';
import { syncBillHeaderPurchaseOrder } from './purchaseOrderBillLinkHeader';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';
import { PurchaseOrderBillLinkRefusal } from './purchaseOrderBillLinkTypes';

export interface UnlinkRequest { poId: string | null; poNumber: string | null; billId: string; reason: string }

export interface UnlinkResult {
  poId: string;
  poNumber: string;
  billId: string;
  invoiceNumber: string;
  linkId: string;
  amountCents: number;
  linesCleared: number;
  poStatusBefore: string;
  poStatusAfter: string;
  reopenedTo: string | null;
}

const NOT_FOUND = (what: string) => new PurchaseOrderBillLinkRefusal(`${what} not found`);

export async function unlinkBillFromPurchaseOrder(
  companyId: string, req: UnlinkRequest, userId: string, via: string,
): Promise<UnlinkResult> {
  const reason = req.reason.trim();
  if (reason === '') throw new PurchaseOrderBillLinkRefusal('Give a reason to unlink a bill from a purchase order');
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  const resolved = (await sql`
    SELECT id::TEXT AS id FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND (id = ${req.poId}::UUID OR po_number = ${req.poNumber}::TEXT)
  `) as DbRow[];
  if (resolved.length !== 1) throw NOT_FOUND('Purchase order');
  const poId = String(resolved[0]!.id);
  const pos = await withRowLockBudget(async () => (await sql`
    SELECT po_number, status FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError(), { deadline });
  const bills = await withRowLockBudget(async () => (await sql`
    SELECT invoice_number FROM supplier_invoices
     WHERE id = ${req.billId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('The bill'), { deadline });
  if (!pos[0] || !bills[0]) throw NOT_FOUND('Purchase order or bill');
  const poNumber = String(pos[0].po_number);
  const status = String(pos[0].status);
  const invoiceNumber = String(bills[0].invoice_number);

  const link = ((await sql`
    SELECT id::TEXT AS id, amount, closed_po_from_status, external_system, external_ref FROM purchase_order_bill_links
     WHERE company_id = ${companyId}::UUID AND purchase_order_id = ${poId}::UUID AND supplier_invoice_id = ${req.billId}::UUID
  `) as DbRow[])[0];
  if (!link) throw new PurchaseOrderBillLinkRefusal(`Bill ${invoiceNumber} is not linked to purchase order ${poNumber}`);

  const cleared = (await sql`
    UPDATE supplier_invoice_items sii SET po_item_id = NULL
      FROM po_items pi
     WHERE sii.supplier_invoice_id = ${req.billId}::UUID AND pi.id = sii.po_item_id AND pi.purchase_order_id = ${poId}::UUID
       AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID)
    RETURNING sii.id
  `) as DbRow[];
  await sql`DELETE FROM purchase_order_bill_links WHERE id = ${String(link.id)}::UUID AND company_id = ${companyId}::UUID`;
  await syncBillHeaderPurchaseOrder(companyId, [req.billId]);

  const from = link.closed_po_from_status == null ? null : String(link.closed_po_from_status);
  let reopenedTo: string | null = null;
  if (from && status === 'closed') {
    const back = (await sql`
      UPDATE purchase_orders SET status = ${from}, updated_at = NOW(), updated_by = ${userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = 'closed' RETURNING id
    `) as DbRow[];
    if (back.length !== 1) throw new Error('The purchase order changed while it was being reopened');
    reopenedTo = from;
  }
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'purchase_order', entityId: poId, entityRef: poNumber.slice(0, 100),
    changes: {
      fields: reopenedTo ? [{ field: 'status', old: 'closed', new: reopenedTo, label: 'Status' }] : [],
      metadata: {
        unlinked_bill: invoiceNumber.slice(0, 100), bill_id: req.billId, link_id: String(link.id), amount: Number(link.amount).toFixed(2),
        lines_cleared: String(cleared.length), reason: reason.slice(0, 500), source: via,
      },
    },
  });
  return {
    poId, poNumber, billId: req.billId, invoiceNumber, linkId: String(link.id), amountCents: Math.round(Number(link.amount) * 100),
    linesCleared: cleared.length, poStatusBefore: status, poStatusAfter: reopenedTo ?? status, reopenedTo,
  };
}
