/**
 * Goods Received Notes (GRN) API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateGRN, generateGRNNumber } from '@/modules/accounting/services/procurementService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as any).companyId as string | undefined;

  if (req.method === 'GET') {
    const { purchaseOrderId } = req.query;
    let rows: Row[];
    if (purchaseOrderId) {
      rows = await sql`SELECT g.*, po.po_number FROM goods_received_notes g LEFT JOIN purchase_orders po ON g.purchase_order_id = po.id WHERE g.purchase_order_id = ${String(purchaseOrderId)} ORDER BY g.received_date DESC` as Row[];
    } else {
      rows = await sql`SELECT g.*, po.po_number, s.name as supplier_name FROM goods_received_notes g LEFT JOIN purchase_orders po ON g.purchase_order_id = po.id LEFT JOIN suppliers s ON po.supplier_id = s.id ORDER BY g.received_date DESC LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const body = req.body;
    const validation = validateGRN(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));

    const countRes = await sql`SELECT COUNT(*) as cnt FROM goods_received_notes` as Row[];
    const grnNumber = generateGRNNumber(Number((countRes[0] as any)?.cnt || 0));

    const inserted = await sql`
      INSERT INTO goods_received_notes (company_id, grn_number, purchase_order_id, received_date, received_by, notes, created_by)
      VALUES (${companyId || null}, ${grnNumber}, ${body.purchaseOrderId}, ${body.receivedDate}, ${body.receivedBy}, ${body.notes || null}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];

    const grnId = String(inserted[0]?.id);
    for (const item of body.items) {
      await sql`INSERT INTO grn_items (grn_id, po_item_id, quantity_received, quantity_rejected, notes) VALUES (${grnId}, ${item.poItemId}, ${item.quantityReceived}, ${item.quantityRejected || 0}, ${item.notes || null})`;
      // Update PO item received quantity
      await sql`UPDATE po_items SET quantity_received = COALESCE(quantity_received, 0) + ${item.quantityReceived} WHERE id = ${item.poItemId}`;
    }

    // Update PO status
    const poItems = await sql`SELECT quantity, quantity_received FROM po_items WHERE purchase_order_id = ${body.purchaseOrderId}` as Row[];
    const allReceived = poItems.every((pi: any) => Number(pi.quantity_received) >= Number(pi.quantity));
    const someReceived = poItems.some((pi: any) => Number(pi.quantity_received) > 0);
    const newStatus = allReceived ? 'received' : someReceived ? 'partially_received' : 'approved';
    await sql`UPDATE purchase_orders SET status = ${newStatus}, updated_at = NOW() WHERE id = ${body.purchaseOrderId}`;

    log.info('GRN created', { grnNumber, po: body.purchaseOrderId }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler));
