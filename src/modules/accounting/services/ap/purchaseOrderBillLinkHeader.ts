/**
 * `supplier_invoices.purchase_order_id` kept in step with the links (design decision 3): the bill's PO when it has
 * exactly one link, NULL when it has none or several.
 *
 * The rule for what may be rewritten (review finding 5): only a header the links manage, i.e. one that is NULL, or names a
 * PO this bill has a link row to, or names `removedPoId` (the PO an unlink just removed). A header naming anything else
 * (an older `supplier_purchase_orders` id, a canonical PO with no link row) is the caller's data and is left as it is.
 * Only a row whose value changes is written. Company-scoped.
 */
import { sql } from '@/lib/neon';

export async function syncBillHeaderPurchaseOrder(
  companyId: string, billIds: readonly string[], removedPoId: string | null = null,
): Promise<void> {
  if (billIds.length === 0) return;
  await sql`
    UPDATE supplier_invoices si SET purchase_order_id = x.po
      FROM (
        SELECT b.id, (SELECT CASE WHEN count(*) = 1 THEN (array_agg(l.purchase_order_id))[1] END
                        FROM purchase_order_bill_links l WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = b.id) AS po
          FROM unnest(${[...billIds]}::UUID[]) AS b(id)
      ) x
     WHERE si.id = x.id AND si.company_id = ${companyId}::UUID AND si.purchase_order_id IS DISTINCT FROM x.po
       AND (si.purchase_order_id IS NULL OR si.purchase_order_id = ${removedPoId}::UUID
            OR EXISTS (SELECT 1 FROM purchase_order_bill_links m WHERE m.company_id = si.company_id
                          AND m.supplier_invoice_id = si.id AND m.purchase_order_id = si.purchase_order_id))
  `;
}
