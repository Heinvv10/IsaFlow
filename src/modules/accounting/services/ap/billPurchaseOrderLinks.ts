/**
 * The bill side of purchase_order_bill_links (migration 1006): which POs a bill is linked to (the MCP bill reads), and
 * the `app` link the REST / MCP bill create writes when it saves a bill naming a canonical PO (design decision 11), so
 * the table stays the one list of links. Company-scoped; reads and one insert, no ledger effect.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** The PO ids each bill is linked to, oldest link first. A bill with none is absent from the map. */
export async function purchaseOrderIdsByBill(companyId: string, billIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (billIds.length === 0) return out;
  const rows = (await sql`
    SELECT l.supplier_invoice_id::TEXT AS bill, l.purchase_order_id::TEXT AS po
      FROM purchase_order_bill_links l
     WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = ANY(${[...billIds]}::UUID[])
     ORDER BY l.created_at, l.id
  `) as DbRow[];
  for (const r of rows) {
    const bill = String(r.bill).toLowerCase();
    out.set(bill, [...(out.get(bill) ?? []), String(r.po)]);
  }
  return out;
}

/**
 * An `app` link for a bill just created with `purchase_order_id` = `poId`, when that is a purchase_orders row of the same
 * company and supplier (a legacy supplier_purchase_orders id, another company's or another supplier's PO gets none:
 * the column is as the caller sent it, as before). Amount: the bill's lines that name a line of that PO, else its
 * subtotal; never above the subtotal; nothing when that is not above zero.
 */
export async function recordAppBillLink(companyId: string, billId: string, poId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, created_by)
    SELECT si.company_id, po.id, si.id, x.amount, 'app', ${userId}
      FROM supplier_invoices si
      JOIN purchase_orders po ON po.id = ${poId}::UUID AND po.company_id = si.company_id AND po.supplier_id = si.supplier_id
      CROSS JOIN LATERAL (
        SELECT LEAST(si.subtotal, COALESCE((
          SELECT SUM(sii.line_total) FROM supplier_invoice_items sii
            JOIN po_items pi ON pi.id = sii.po_item_id AND pi.purchase_order_id = po.id
           WHERE sii.supplier_invoice_id = si.id), si.subtotal)) AS amount
      ) x
     WHERE si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID AND x.amount > 0
    ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING
  `;
}
