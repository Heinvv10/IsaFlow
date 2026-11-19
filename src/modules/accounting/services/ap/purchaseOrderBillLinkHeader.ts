/**
 * `supplier_invoices.purchase_order_id` kept in step with the links (design decision 3): the bill's PO when it has
 * exactly one link, NULL when it has none or several. Only a row whose value changes is written. Company-scoped.
 */
import { sql } from '@/lib/neon';

export async function syncBillHeaderPurchaseOrder(companyId: string, billIds: readonly string[]): Promise<void> {
  if (billIds.length === 0) return;
  await sql`
    UPDATE supplier_invoices si SET purchase_order_id = x.po
      FROM (
        SELECT b.id, (SELECT CASE WHEN count(*) = 1 THEN (array_agg(l.purchase_order_id))[1] END
                        FROM purchase_order_bill_links l WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = b.id) AS po
          FROM unnest(${[...billIds]}::UUID[]) AS b(id)
      ) x
     WHERE si.id = x.id AND si.company_id = ${companyId}::UUID AND si.purchase_order_id IS DISTINCT FROM x.po
  `;
}
