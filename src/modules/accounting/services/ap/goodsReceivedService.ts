import { sql, withTransaction } from '@/lib/neon';
import { requireCtx } from '@/lib/als';
import { GoodsReceivedError, parseGoodsReceived } from './goodsReceivedValidation';
export { GoodsReceivedError } from './goodsReceivedValidation';

export async function createGoodsReceived(companyId: string, userId: string, input: unknown) {
  const ctx = requireCtx();
  if (ctx.companyId !== companyId || ctx.userId !== userId) throw new Error('Receipt requires the authenticated company transaction');
  const body = parseGoodsReceived(input, userId);
  return withTransaction(async () => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 620))`;
    const orders = await sql<{ id: string; status: string }>`
      SELECT id,status FROM purchase_orders WHERE id=${body.purchaseOrderId}::uuid AND company_id=${companyId}::uuid FOR UPDATE
    `;
    const order = orders[0];
    if (!order) throw new GoodsReceivedError('Purchase order not found', true);
    if (!['approved', 'partially_received'].includes(order.status)) throw new GoodsReceivedError('Only approved or partially received orders accept receipts');
    const items = await sql<{ id: string; quantity: string; quantity_received: string | null }>`
      SELECT pi.id,pi.quantity,pi.quantity_received FROM po_items pi
      JOIN purchase_orders po ON po.id=pi.purchase_order_id
      WHERE po.company_id=${companyId}::uuid AND po.id=${order.id}::uuid ORDER BY pi.id FOR UPDATE OF pi
    `;
    for (const line of body.items) {
      const item = items.find(item => item.id === line.poItemId);
      if (!item) throw new GoodsReceivedError('Every receipt line must belong to this purchase order');
      const remaining = Math.round(Number(item.quantity) * 100) - Math.round(Number(item.quantity_received ?? 0) * 100);
      if (Math.round(line.quantityReceived * 100) > remaining) throw new GoodsReceivedError('Received quantity exceeds the outstanding order quantity');
    }
    const sequence = await sql<{ next: string }>`
      SELECT (COALESCE(MAX(substring(grn_number from 5)::numeric),0)+1)::text AS next
      FROM goods_received_notes WHERE company_id=${companyId}::uuid AND grn_number ~ '^GRN-[0-9]+$'
    `;
    const number = `GRN-${sequence[0]!.next.padStart(5, '0')}`;
    const rows = await sql`
      INSERT INTO goods_received_notes(company_id,grn_number,purchase_order_id,received_date,received_by,notes,created_by)
      VALUES(${companyId}::uuid,${number},${order.id}::uuid,${body.receivedDate}::date,${body.receivedBy},${body.notes ?? null},${userId}) RETURNING *
    `;
    const receipt = rows[0]!;
    for (const line of body.items) {
      await sql`
        INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quantity_rejected,notes)
        SELECT g.id,pi.id,${line.quantityReceived},${line.quantityRejected},${line.notes ?? null}
        FROM goods_received_notes g JOIN purchase_orders po ON po.id=g.purchase_order_id AND po.company_id=g.company_id
        JOIN po_items pi ON pi.purchase_order_id=po.id
        WHERE g.id=${receipt.id}::uuid AND g.company_id=${companyId}::uuid AND pi.id=${line.poItemId}::uuid
      `;
      await sql`
        UPDATE po_items pi SET quantity_received=COALESCE(pi.quantity_received,0)+${line.quantityReceived}
        FROM purchase_orders po WHERE pi.purchase_order_id=po.id AND po.company_id=${companyId}::uuid
          AND po.id=${order.id}::uuid AND pi.id=${line.poItemId}::uuid
      `;
    }
    await sql`
      UPDATE purchase_orders po SET status=CASE
        WHEN NOT EXISTS(SELECT 1 FROM po_items pi WHERE pi.purchase_order_id=po.id AND COALESCE(pi.quantity_received,0)<pi.quantity) THEN 'received'
        WHEN EXISTS(SELECT 1 FROM po_items pi WHERE pi.purchase_order_id=po.id AND pi.quantity_received>0) THEN 'partially_received'
        ELSE 'approved' END,updated_at=NOW()
      WHERE po.id=${order.id}::uuid AND po.company_id=${companyId}::uuid
    `;
    return receipt;
  });
}
