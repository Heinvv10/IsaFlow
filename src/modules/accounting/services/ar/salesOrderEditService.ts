/**
 * The draft edit of a customer sales order — split from salesOrderService.ts
 * (which re-exports it) for the 300-line cap when R-035 PR4 round 2 made it
 * record its editor: an edit that changes what the order bills makes the
 * editor an author of the order, and so of the invoice converted from it
 * (sourceContentEditor; derived by approval_document_authors, migration 865).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCustomerInCompany } from '../core/contactDirectoryService';
import { calcTotals, getSalesOrder, type SalesOrder, type SalesOrderInput } from './salesOrderService';
import { withSourceEditorStamp } from './sourceContentEditor';

type Row = DbRow;

export async function updateSalesOrder(
  companyId: string,
  id: string,
  input: SalesOrderInput,
  /** R-035 PR4 round 2: recorded as an author of the order (and its invoice) when the edit changes what it bills. */
  editedBy: string,
): Promise<SalesOrder | null> {
  const existing = await getSalesOrder(companyId, id);
  if (!existing || existing.status !== 'draft') return null;
  await assertCustomerInCompany(companyId, input.customer_id);
  const { subtotal, taxAmount, totalAmount } = calcTotals(input.items);

  // The row count decides whether the lines may be rewritten. The header UPDATE
  // has always been predicated on 'draft', but its count was discarded and the
  // DELETE + re-INSERT of the items below ran regardless: a request that read
  // 'draft' and was then beaten by a confirm or an invoice-conversion left the
  // header untouched and replaced the lines of an order that had already been
  // billed. Zero rows now means the order moved, and this returns null.
  return withSourceEditorStamp(companyId, { kind: 'sales_order', id }, editedBy, async () => {
  const claimed = (await sql`
    UPDATE customer_sales_orders SET
      customer_id = ${input.customer_id || existing.customerId},
      order_date = ${input.order_date || existing.orderDate},
      delivery_date = ${input.delivery_date || null},
      reference = ${input.reference || null},
      subtotal = ${subtotal}, tax_amount = ${taxAmount}, total_amount = ${totalAmount},
      notes = ${input.notes || null}, internal_notes = ${input.internal_notes || null},
      updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING id
  `) as Row[];
  if (claimed.length === 0) return null;

  // Parent-verified: getSalesOrder(companyId, id) at the top of this function early-returns null for cross-tenant ids, so this sales_order_id is tenant-owned.
  await sql`DELETE FROM customer_sales_order_items WHERE sales_order_id = ${id}::UUID`;
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (!item) continue;
    const lineTotal = Math.round(item.quantity * item.unit_price * 100) / 100;
    await sql`
      INSERT INTO customer_sales_order_items (
        sales_order_id, line_number, description, quantity, unit_price, tax_rate, line_total
      ) VALUES (
        ${id}::UUID, ${i + 1}, ${item.description}, ${item.quantity},
        ${item.unit_price}, ${item.tax_rate ?? 15}, ${lineTotal}
      )
    `;
  }
  log.info('Sales order updated', { id });
  return getSalesOrder(companyId, id);
  });
}
