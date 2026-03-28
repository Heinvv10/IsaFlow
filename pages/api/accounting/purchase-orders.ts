/**
 * Purchase Orders API — CRUD
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validatePurchaseOrder, calculatePOTotals, generatePONumber } from '@/modules/accounting/services/procurementService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as any).companyId as string | undefined;

  if (req.method === 'GET') {
    const { status, supplierId } = req.query;
    let rows: Row[];
    if (status) {
      rows = await sql`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.status = ${String(status)} ORDER BY po.created_at DESC LIMIT 200` as Row[];
    } else if (supplierId) {
      rows = await sql`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.supplier_id = ${String(supplierId)} ORDER BY po.created_at DESC LIMIT 200` as Row[];
    } else {
      rows = await sql`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id ORDER BY po.created_at DESC LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const body = req.body;
    const validation = validatePurchaseOrder(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));

    const totals = calculatePOTotals(body.items);
    const countRes = await sql`SELECT COUNT(*) as cnt FROM purchase_orders` as Row[];
    const poNumber = generatePONumber(Number((countRes[0] as any)?.cnt || 0));

    const inserted = await sql`
      INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total, notes, reference, created_by)
      VALUES (${companyId || null}, ${poNumber}, ${body.supplierId}, ${body.orderDate || new Date().toISOString().split('T')[0]}, ${body.expectedDeliveryDate || null}, ${totals.subtotal}, ${totals.taxAmount}, ${totals.total}, ${body.notes || null}, ${body.reference || null}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];

    const poId = String(inserted[0]?.id);
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
      const lineTax = Math.round(lineTotal * (item.taxRate || 15) / 100 * 100) / 100;
      await sql`INSERT INTO po_items (purchase_order_id, product_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, sort_order) VALUES (${poId}, ${item.productId || null}, ${item.description}, ${item.quantity}, ${item.unitPrice}, ${item.taxRate || 15}, ${lineTotal}, ${lineTax}, ${i})`;
    }

    log.info('Purchase order created', { poNumber, supplier: body.supplierId, total: totals.total }, 'accounting');
    return apiResponse.created(res, { ...inserted[0], items: body.items });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as any));
