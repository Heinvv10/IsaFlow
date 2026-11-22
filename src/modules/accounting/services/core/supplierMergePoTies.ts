/**
 * Supplier merge and the source's bills tied to its purchase orders (migration 1006; PR #1703 merge review HIGH 1). A merge moves bills
 * but never `purchase_orders` (the #1697 invariant: a PO, its goods received notes and their links stay with the source), so a moved
 * bill still tied to a source PO, by a link row, its header (`purchase_order_id`) or a line (`po_item_id`), would name another
 * supplier's PO. Both merge paths (core/duplicateMergeService.ts, pages/api/accounting/supplier-merge.ts) refuse, twice:
 *   - `assertSupplierMergeMovesNoPoTiedBill`, a 400 before anything moves, after the merge holds both supplier rows FOR UPDATE and
 *     BEFORE the noted-bill check (supplierMergeNotedBills.ts): a bill OF THE SOURCE tied to a PO OF THE SOURCE, in any bill state (a
 *     cancelled or deleted bill's tie names the PO too; the exit, unlink_bill_from_purchase_order, takes any state);
 *   - `refuseIfMovedPoTiedBills`, on the ids the merge's own bill UPDATE moved (review of cce5386b17): a draft edit that sets a header
 *     or a line tie without the supplier lock, between the check and the UPDATE, is invisible to the check (the 1006 guard sees link
 *     rows only), and the UPDATE, having waited on the row, moves it after that edit commits. The caller's savepoint takes the merge back.
 * A header or line naming a legacy or foreign id that is no PO of the source is no tie (the header has no FK).
 */
import { sql } from '@/lib/neon';
import { SupplierMergeRefusal } from './supplierMergeRefusal';

const REFUSAL = 'This supplier has bills linked to purchase orders of its own (by a link, a bill\'s header or one of its lines), '
  + 'and a merge moves the bills but leaves the purchase orders with this supplier. Unlink them (unlink_bill_from_purchase_order) '
  + 'before merging, so no bill names another supplier\'s purchase order.';

/** The bills tied to a PO of `sourceId`: the source's own bills, or (`moved`) exactly these ids, wherever they are now. */
async function poTiedBills(companyId: string, sourceId: string, moved: readonly string[] | null): Promise<boolean> {
  const ids = [...(moved ?? [])];
  const byIds = moved !== null;
  const rows = (await sql`
    SELECT 1 FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID
       AND ((NOT ${byIds}::BOOLEAN AND si.supplier_id = ${sourceId}::UUID) OR si.id = ANY(${ids}::UUID[]))
       AND (EXISTS (SELECT 1 FROM purchase_order_bill_links l
                      JOIN purchase_orders po ON po.id = l.purchase_order_id AND po.company_id = l.company_id
                     WHERE l.company_id = si.company_id AND l.supplier_invoice_id = si.id AND po.supplier_id = ${sourceId}::UUID)
         OR EXISTS (SELECT 1 FROM purchase_orders po
                     WHERE po.company_id = si.company_id AND po.id = si.purchase_order_id AND po.supplier_id = ${sourceId}::UUID)
         OR EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                      JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = si.company_id
                     WHERE x.supplier_invoice_id = si.id AND po.supplier_id = ${sourceId}::UUID))
     LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

export async function assertSupplierMergeMovesNoPoTiedBill(companyId: string, sourceId: string): Promise<void> {
  if (await poTiedBills(companyId, sourceId, null)) throw new SupplierMergeRefusal(REFUSAL);
}

/** After the merge's bill UPDATE ... RETURNING id: refused when a moved bill is tied to a PO of the source (a late header / line tie). */
export async function refuseIfMovedPoTiedBills(companyId: string, sourceId: string, moved: ReadonlyArray<{ id?: unknown }>): Promise<void> {
  const ids = moved.map((r) => String(r.id));
  if (ids.length > 0 && await poTiedBills(companyId, sourceId, ids)) throw new SupplierMergeRefusal(REFUSAL);
}
