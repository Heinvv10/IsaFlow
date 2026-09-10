/**
 * Purchase Orders API — CRUD
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validatePurchaseOrder, calculatePOTotals } from '@/modules/accounting/services/ap/procurementService';
import { insertWithReservedNumber } from '@/modules/accounting/services/core/documentNumberRetry';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as CompanyAuthedRequest).companyId;

  if (req.method === 'GET') {
    const { status, supplierId } = req.query;
    let rows: Row[];
    if (status) {
      rows = await sql`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.company_id = ${companyId}::UUID AND po.status = ${String(status)} ORDER BY po.created_at DESC LIMIT 200` as Row[];
    } else if (supplierId) {
      rows = await sql`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.company_id = ${companyId}::UUID AND po.supplier_id = ${String(supplierId)} ORDER BY po.created_at DESC LIMIT 200` as Row[];
    } else {
      rows = await sql`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.company_id = ${companyId}::UUID ORDER BY po.created_at DESC LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const body = req.body;
    const validation = validatePurchaseOrder(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));

    const totals = calculatePOTotals(body.items);

    // The number comes from the company's `purchase_order` sequence. What this
    // replaced was COUNT(*)+1 against a UNIQUE(company_id, po_number): count is
    // not max, so after a single PO was deleted every later create re-issued a
    // number that already existed and 23505'd — permanently, since the count
    // never caught up — with no savepoint and no retry, wedging PO creation for
    // that company until someone renumbered by hand.
    const inserted = await insertWithReservedNumber(
      companyId, 'purchase_order', 'po_insert_', 'purchase_orders_company_id_po_number_key',
      async (poNumber) => (await sql`
        INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total, notes, reference, created_by)
        VALUES (${companyId || null}, ${poNumber}, ${body.supplierId}, ${body.orderDate || new Date().toISOString().split('T')[0]}, ${body.expectedDeliveryDate || null}, ${totals.subtotal}, ${totals.taxAmount}, ${totals.total}, ${body.notes || null}, ${body.reference || null}, ${String(req.user.id)})
        RETURNING *
      ` as Row[]),
    );
    const poNumber = String(inserted[0]?.po_number);

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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
