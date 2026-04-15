/**
 * Purchase Order Detail API
 * GET    /api/accounting/purchase-orders/[id] — Get single PO with line items
 * PUT    /api/accounting/purchase-orders/[id] — Update draft PO
 * DELETE /api/accounting/purchase-orders/[id] — Delete draft PO
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withCompany,
  type CompanyApiRequest,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'id is required');

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const poRows = await sql`
      SELECT po.*,
        s.name    AS supplier_name,
        s.email   AS supplier_email,
        s.phone   AS supplier_phone,
        s.address AS supplier_address
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = ${id}::UUID AND po.company_id = ${companyId}::UUID
    ` as Row[];

    if (poRows.length === 0) return apiResponse.notFound(res, 'Purchase order', id);

    const items = await sql`
      SELECT pi.*, g.account_name, g.account_code
      FROM po_items pi
      LEFT JOIN gl_accounts g ON g.id = pi.gl_account_id
      WHERE pi.purchase_order_id = ${id}::UUID
      ORDER BY pi.sort_order
    ` as Row[];

    return apiResponse.success(res, { ...poRows[0], items });
  }

  // ── PUT ────────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const {
      supplier_id,
      order_date,
      expected_delivery_date,
      reference,
      notes,
      status,
      items,
    } = req.body as {
      supplier_id?: string;
      order_date?: string;
      expected_delivery_date?: string | null;
      reference?: string | null;
      notes?: string | null;
      status?: string;
      items?: Array<{
        id?: string;
        description: string;
        quantity: number;
        unit_price: number;
        tax_rate?: number;
        gl_account_id?: string | null;
        product_id?: string | null;
        sort_order?: number;
      }>;
    };

    // Fetch current PO to verify ownership and status
    const existing = await sql`
      SELECT id, status FROM purchase_orders
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    ` as Row[];

    if (existing.length === 0) return apiResponse.notFound(res, 'Purchase order', id);

    const currentStatus = String(existing[0]!.status);
    const allowedEditStatuses = ['draft', 'submitted'];
    if (!allowedEditStatuses.includes(currentStatus)) {
      return apiResponse.badRequest(res, `Cannot edit a ${currentStatus} purchase order`);
    }

    // Compute totals from items if provided
    let subtotal: number | undefined;
    let taxAmount: number | undefined;
    let total: number | undefined;

    if (Array.isArray(items) && items.length > 0) {
      subtotal = 0;
      taxAmount = 0;
      for (const item of items) {
        const lineTotal = Math.round((item.quantity || 0) * (item.unit_price || 0) * 100) / 100;
        const lineTax = Math.round(lineTotal * ((item.tax_rate ?? 15) / 100) * 100) / 100;
        subtotal += lineTotal;
        taxAmount += lineTax;
      }
      total = Math.round((subtotal + taxAmount) * 100) / 100;
    }

    const updated = await sql`
      UPDATE purchase_orders SET
        supplier_id            = COALESCE(${supplier_id ?? null}::UUID, supplier_id),
        order_date             = COALESCE(${order_date ?? null}::DATE, order_date),
        expected_delivery_date = ${expected_delivery_date !== undefined ? expected_delivery_date : null},
        reference              = ${reference !== undefined ? reference : null},
        notes                  = ${notes !== undefined ? notes : null},
        status                 = COALESCE(${status ?? null}, status),
        subtotal               = COALESCE(${subtotal ?? null}, subtotal),
        tax_amount             = COALESCE(${taxAmount ?? null}, tax_amount),
        total                  = COALESCE(${total ?? null}, total),
        updated_at             = NOW(),
        updated_by             = ${String(req.user.id)}
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      RETURNING *
    ` as Row[];

    if (updated.length === 0) return apiResponse.notFound(res, 'Purchase order', id);

    // Replace line items if provided
    if (Array.isArray(items) && items.length > 0) {
      await sql`DELETE FROM po_items WHERE purchase_order_id = ${id}::UUID`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const lineTotal = Math.round((item.quantity || 0) * (item.unit_price || 0) * 100) / 100;
        const lineTax = Math.round(lineTotal * ((item.tax_rate ?? 15) / 100) * 100) / 100;
        await sql`
          INSERT INTO po_items
            (purchase_order_id, product_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, sort_order)
          VALUES
            (${id}::UUID,
             ${item.product_id ?? null},
             ${item.description},
             ${item.quantity},
             ${item.unit_price},
             ${item.tax_rate ?? 15},
             ${lineTotal},
             ${lineTax},
             ${item.gl_account_id ?? null},
             ${i})
        `;
      }
    }

    log.info('Purchase order updated', { id, status, total }, 'accounting');

    const newItems = await sql`
      SELECT * FROM po_items WHERE purchase_order_id = ${id}::UUID ORDER BY sort_order
    ` as Row[];

    return apiResponse.success(res, { ...updated[0], items: newItems });
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const existing = await sql`
      SELECT id, status FROM purchase_orders
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    ` as Row[];

    if (existing.length === 0) return apiResponse.notFound(res, 'Purchase order', id);
    if (String(existing[0]!.status) !== 'draft') {
      return apiResponse.badRequest(res, 'Only draft purchase orders can be deleted');
    }

    await sql`DELETE FROM purchase_orders WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
    log.info('Purchase order deleted', { id }, 'accounting');
    return apiResponse.success(res, { deleted: true, id });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
