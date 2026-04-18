/**
 * GET /api/accounting/purchase-orders/unmatched
 * Returns POs for a supplier that are not yet fully invoiced
 * (status in submitted/approved/partially_received/received, quantity_invoiced < quantity).
 * Also returns GRNs scoped to a supplier or a specific PO.
 *
 * Query params:
 *   supplierId   — required
 *   purchaseOrderId — optional, filters GRN list to a specific PO
 *   include      — "pos" | "grns" | "both" (default "both")
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const companyId = (req as CompanyAuthedRequest).companyId;
  const { supplierId, purchaseOrderId, include = 'both' } = req.query;

  if (!supplierId) {
    return apiResponse.badRequest(res, 'supplierId is required');
  }

  const supplierIdStr = String(supplierId);
  const poIdStr = purchaseOrderId ? String(purchaseOrderId) : null;
  const wantPos = include === 'pos' || include === 'both';
  const wantGrns = include === 'grns' || include === 'both';

  const unmatchedStatuses = ['submitted', 'approved', 'partially_received', 'received'];

  // Fetch POs: status in the open statuses AND at least one item not fully invoiced
  const pos: Row[] = wantPos
    ? (await sql`
        SELECT DISTINCT po.id, po.po_number, po.order_date, po.expected_delivery_date,
               po.status, po.total, po.subtotal
        FROM purchase_orders po
        INNER JOIN po_items pi ON pi.purchase_order_id = po.id
        WHERE po.company_id = ${companyId}::UUID
          AND po.supplier_id = ${supplierIdStr}::UUID
          AND po.status = ANY(${unmatchedStatuses}::text[])
          AND (pi.quantity_invoiced IS NULL OR pi.quantity_invoiced < pi.quantity)
        ORDER BY po.order_date DESC
        LIMIT 100
      `) as Row[]
    : [];

  // Fetch GRNs: scoped by supplier (via PO join) or specific PO
  let grns: Row[] = [];
  if (wantGrns) {
    if (poIdStr) {
      grns = (await sql`
        SELECT g.id, g.grn_number, g.received_date, g.notes,
               po.po_number, po.id AS purchase_order_id
        FROM goods_received_notes g
        INNER JOIN purchase_orders po ON po.id = g.purchase_order_id
        WHERE g.company_id = ${companyId}
          AND g.purchase_order_id = ${poIdStr}::UUID
        ORDER BY g.received_date DESC
        LIMIT 100
      `) as Row[];
    } else {
      grns = (await sql`
        SELECT g.id, g.grn_number, g.received_date, g.notes,
               po.po_number, po.id AS purchase_order_id
        FROM goods_received_notes g
        INNER JOIN purchase_orders po ON po.id = g.purchase_order_id
        WHERE g.company_id = ${companyId}
          AND po.supplier_id = ${supplierIdStr}::UUID
        ORDER BY g.received_date DESC
        LIMIT 100
      `) as Row[];
    }
  }

  return apiResponse.success(res, { pos, grns });
}

export default withAuth(withErrorHandler(handler as never));
