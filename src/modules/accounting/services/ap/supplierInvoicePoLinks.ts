/**
 * A bill line's `po_item_id` (budgets P5-3 security review). `supplier_invoice_items.po_item_id` has no FK and
 * po_items no company_id, and the line's PO link nets that PO line's budget commitment (`budgets/remainingCommitted`)
 * and drives the 3-way match: a bill naming ANOTHER company's PO line would release that company's commitment.
 * So every named `po_item_id` must be a line of one of this company's purchase orders, of the bill's own supplier, in
 * a status that commits spend (approved / partially_received / received: a draft, submitted or cancelled order has
 * nothing to bill against) and, when the bill names a `purchase_order_id`, of that order. Reads only, before any
 * write; refusal = 400. The REST create is the only writer of the column (census 7): `createSupplierInvoice`, and
 * the route ahead of its number reservation.
 * Named limit: the header `purchase_order_id` alone (no line naming a PO line) is not checked here.
 *
 * `lock: true` (the create's own transaction, before it inserts the bill or its lines): the named POs are taken `FOR KEY SHARE`
 * in id order and the checks run again UNDER that lock. Without it a PO edit (`update_purchase_order`: `FOR UPDATE`, replaces the
 * po_items rows) could slip between this check and the line insert and leave the bill line naming a deleted PO line; with it the
 * edit waits for the bill's commit (and then refuses, the line being tied), or the bill, arriving second, finds the line gone and
 * is refused. Lock order (census): the bill row is new, nobody else can hold it, so the PO rows are the first lock a create takes;
 * a draft edit holds its bill and then takes the same `KEY SHARE`, so the two never invert.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { COMMITTING_PO_STATUSES } from '../budgets/remainingCommitted';

export class SupplierInvoicePoLinkRefusal extends Error {
  readonly code = 'SUPPLIER_INVOICE_PO_LINK_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoicePoLinkRefusal';
  }
}

export async function assertBillPoLinks(
  companyId: string, purchaseOrderId: unknown, supplierId: string, items: ReadonlyArray<{ poItemId?: unknown }>,
  opts: { db?: typeof sql | TxSql; lock?: boolean } = {},
): Promise<void> {
  const named = items.map((i) => i.poItemId).filter((v) => v !== undefined && v !== null && v !== '');
  if (named.length === 0) return;
  if (named.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) {
    throw new SupplierInvoicePoLinkRefusal('A bill line names a purchase order line that is not a valid id');
  }
  const ids = [...new Set((named as string[]).map((v) => v.toLowerCase()))];
  const order = typeof purchaseOrderId === 'string' && purchaseOrderId !== '' ? purchaseOrderId : null;
  if (order !== null && !UUID_RE.test(order)) throw new SupplierInvoicePoLinkRefusal('The bill names a purchase order that is not a valid id');
  const db = opts.db ?? sql;
  if (opts.lock) {
    // The POs the named lines belong to (any company's id resolves to nothing here: the company filter), id order.
    await db`
      SELECT po.id FROM purchase_orders po
       WHERE po.company_id = ${companyId}::UUID AND po.id IN (SELECT pi.purchase_order_id FROM po_items pi WHERE pi.id = ANY(${ids}::UUID[]))
       ORDER BY po.id FOR KEY SHARE OF po
    `;
  }
  const found = (await db`
    SELECT pi.id::TEXT AS id, pi.purchase_order_id::TEXT AS po, po.supplier_id::TEXT AS supplier, po.status
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
  if (found.some((r) => String(r.supplier).toLowerCase() !== supplierId.toLowerCase())) {
    throw new SupplierInvoicePoLinkRefusal('A bill line names a purchase order line of another supplier\'s purchase order');
  }
  if (found.some((r) => !(COMMITTING_PO_STATUSES as readonly string[]).includes(String(r.status)))) {
    throw new SupplierInvoicePoLinkRefusal('A bill line names a purchase order line of an order that is not approved (draft, submitted or cancelled)');
  }
}
