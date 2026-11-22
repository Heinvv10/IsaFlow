/**
 * Supplier merge and the source's bills tied to its purchase orders (migration 1006; PR #1703 merge review HIGH 1). A merge moves bills
 * but never `purchase_orders` (the #1697 invariant: a PO, its goods received notes and their links stay with the source), so a moved
 * bill still tied to a source PO, by a link row, its header (`purchase_order_id`) or a line (`po_item_id`), would name another
 * supplier's PO. Both merge paths (core/duplicateMergeService.ts, pages/api/accounting/supplier-merge.ts) refuse, a 400 before anything
 * moves, after the merge holds both supplier rows FOR UPDATE and BEFORE the noted-bill check (supplierMergeNotedBills.ts). Any bill
 * state: a cancelled or deleted bill's tie names the PO too, and the exit, unlink_bill_from_purchase_order, takes any bill state.
 * A header holding a legacy or foreign id that is no PO of the source is no tie (the column has no FK).
 */
import { sql } from '@/lib/neon';
import { SupplierMergeRefusal } from './supplierMergeRefusal';

export async function assertSupplierMergeMovesNoPoTiedBill(companyId: string, sourceId: string): Promise<void> {
  const tied = (await sql`
    SELECT 1 FROM purchase_orders po
     WHERE po.company_id = ${companyId}::UUID AND po.supplier_id = ${sourceId}::UUID AND (
           EXISTS (SELECT 1 FROM purchase_order_bill_links l WHERE l.company_id = po.company_id AND l.purchase_order_id = po.id)
        OR EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.company_id = po.company_id AND si.purchase_order_id = po.id)
        OR EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id WHERE pi.purchase_order_id = po.id))
     LIMIT 1
  `) as unknown[];
  if (tied.length === 0) return;
  throw new SupplierMergeRefusal(
    'This supplier has bills linked to purchase orders (by a link, a bill\'s header or its lines), and a merge leaves purchase orders with this '
    + 'supplier. Unlink them (unlink_bill_from_purchase_order) before merging, so no bill names another supplier\'s purchase order.',
  );
}
