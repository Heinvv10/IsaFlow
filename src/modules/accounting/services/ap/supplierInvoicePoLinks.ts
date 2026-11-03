/**
 * A bill line's `po_item_id` (budgets P5-3 security review). `supplier_invoice_items.po_item_id` has no FK and
 * po_items no company_id, and the line's PO link nets that PO line's budget commitment (`budgets/remainingCommitted`)
 * and drives the 3-way match: a bill naming ANOTHER company's PO line would release that company's commitment.
 * So every named `po_item_id` must be a line of one of this company's purchase orders and, when the bill names a
 * `purchase_order_id`, of that order. Reads only, before any write; refusal = 400. The REST create is the only writer
 * of the column (census 7): `createSupplierInvoice`, and the route ahead of its number reservation.
 * Named limit: the header `purchase_order_id` alone (no line naming a PO line) is not checked here.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';

export class SupplierInvoicePoLinkRefusal extends Error {
  readonly code = 'SUPPLIER_INVOICE_PO_LINK_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoicePoLinkRefusal';
  }
}

export async function assertBillPoLinks(
  companyId: string, purchaseOrderId: unknown, items: ReadonlyArray<{ poItemId?: unknown }>,
): Promise<void> {
  const named = items.map((i) => i.poItemId).filter((v) => v !== undefined && v !== null && v !== '');
  if (named.length === 0) return;
  if (named.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) {
    throw new SupplierInvoicePoLinkRefusal('A bill line names a purchase order line that is not a valid id');
  }
  const ids = [...new Set((named as string[]).map((v) => v.toLowerCase()))];
  const order = typeof purchaseOrderId === 'string' && purchaseOrderId !== '' ? purchaseOrderId : null;
  if (order !== null && !UUID_RE.test(order)) throw new SupplierInvoicePoLinkRefusal('The bill names a purchase order that is not a valid id');
  const found = (await sql`
    SELECT pi.id::TEXT AS id, pi.purchase_order_id::TEXT AS po
      FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.id = ANY(${ids}::UUID[])
  `) as DbRow[];
  const poOf = new Map(found.map((r) => [String(r.id).toLowerCase(), String(r.po).toLowerCase()]));
  if (ids.some((i) => !poOf.has(i))) {
    throw new SupplierInvoicePoLinkRefusal('A bill line names a purchase order line that is not one of this company\'s purchase orders');
  }
  if (order !== null && ids.some((i) => poOf.get(i) !== order.toLowerCase())) {
    throw new SupplierInvoicePoLinkRefusal('A bill line names a purchase order line of another purchase order than the bill\'s');
  }
}
