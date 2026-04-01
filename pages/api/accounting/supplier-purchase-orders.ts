/**
 * Supplier Purchase Orders API
 * GET    /api/accounting/supplier-purchase-orders           - List purchase orders
 * GET    /api/accounting/supplier-purchase-orders?id=UUID   - Get single order with items
 * POST   /api/accounting/supplier-purchase-orders           - Create purchase order
 * PUT    /api/accounting/supplier-purchase-orders           - Update draft purchase order
 * DELETE /api/accounting/supplier-purchase-orders           - Delete draft purchase order
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import type { AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import sql from '@/lib/neon';

interface PurchaseOrderItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
}

/**
 * Generate the next order number using company_document_numbers table
 */
async function generateOrderNumber(companyId: string): Promise<string> {
  const rows = await sql`
    UPDATE company_document_numbers
    SET next_number = next_number + 1
    WHERE company_id = ${companyId}::UUID AND document_type = 'purchase_order'
    RETURNING prefix, next_number - 1 AS current_number, padding
  `;

  if (rows.length === 0) {
    // Seed default if missing
    await sql`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
      VALUES (${companyId}::UUID, 'purchase_order', 'PO', 2, 7)
      ON CONFLICT (company_id, document_type) DO NOTHING
    `;
    return 'PO-0000001';
  }

  const row = rows[0]!;
  return `${row.prefix}-${String(row.next_number).padStart(row.padding, '0')}`;
}

/**
 * Calculate totals from line items
 */
function calculateTotals(items: PurchaseOrderItem[]) {
  let subtotal = 0;
  let taxAmount = 0;

  for (const item of items) {
    const lineTotal = item.quantity * item.unit_price;
    const lineTax = lineTotal * (item.tax_rate / 100);
    subtotal += lineTotal;
    taxAmount += lineTax;
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    totalAmount: Math.round((subtotal + taxAmount) * 100) / 100,
  };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  // ── GET: List or single ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { id, status, search, limit, offset } = req.query;

      // Single order with items
      if (id) {
        const orders = await sql`
          SELECT po.*, s.name AS supplier_name
          FROM supplier_purchase_orders po
          LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
          WHERE po.id = ${String(id)}::UUID AND po.company_id = ${companyId}::UUID
        `;

        if (orders.length === 0) {
          return apiResponse.notFound(res, 'Purchase order');
        }

        const items = await sql`
          SELECT * FROM supplier_purchase_order_items
          WHERE purchase_order_id = ${String(id)}::UUID
          ORDER BY created_at ASC
        `;

        return apiResponse.success(res, { order: orders[0], items });
      }

      // List orders
      const take = Math.min(Number(limit) || 100, 500);
      const skip = Number(offset) || 0;
      const statusFilter = status ? String(status) : null;
      const searchTerm = search ? `%${String(search)}%` : null;

      const orders = await sql`
        SELECT po.*, s.name AS supplier_name
        FROM supplier_purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
        WHERE po.company_id = ${companyId}::UUID
          AND (${statusFilter}::TEXT IS NULL OR po.status = ${statusFilter})
          AND (
            ${searchTerm}::TEXT IS NULL
            OR po.order_number ILIKE ${searchTerm}
            OR po.reference ILIKE ${searchTerm}
            OR s.name ILIKE ${searchTerm}
          )
        ORDER BY po.created_at DESC
        LIMIT ${take} OFFSET ${skip}
      `;

      const countResult = await sql`
        SELECT COUNT(*)::INT AS total
        FROM supplier_purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
        WHERE po.company_id = ${companyId}::UUID
          AND (${statusFilter}::TEXT IS NULL OR po.status = ${statusFilter})
          AND (
            ${searchTerm}::TEXT IS NULL
            OR po.order_number ILIKE ${searchTerm}
            OR po.reference ILIKE ${searchTerm}
            OR s.name ILIKE ${searchTerm}
          )
      `;

      return apiResponse.success(res, {
        orders,
        total: countResult[0]?.total ?? 0,
      });
    } catch (err) {
      log.error('Failed to get purchase orders', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get purchase orders');
    }
  }

  // ── POST: Create ───────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const {
        supplier_id, order_date, delivery_date, reference, notes, internal_notes, items,
      } = req.body;

      if (!supplier_id || !order_date || !items || !Array.isArray(items) || items.length === 0) {
        return apiResponse.badRequest(res, 'supplier_id, order_date, and at least one item are required');
      }

      const userId = req.user.id;
      const orderNumber = await generateOrderNumber(companyId);
      const { subtotal, taxAmount, totalAmount } = calculateTotals(items);

      const created = await sql`
        INSERT INTO supplier_purchase_orders (
          company_id, supplier_id, order_number, order_date, delivery_date,
          reference, notes, internal_notes, status,
          subtotal, tax_amount, total_amount,
          created_by
        ) VALUES (
          ${companyId}::UUID, ${supplier_id}::UUID, ${orderNumber},
          ${order_date}::DATE, ${delivery_date ? delivery_date : null}::DATE,
          ${reference || null}, ${notes || null}, ${internal_notes || null}, 'draft',
          ${subtotal}, ${taxAmount}, ${totalAmount},
          ${userId}::UUID
        )
        RETURNING *
      `;

      const order = created[0]!;

      // Insert line items
      for (const item of items as PurchaseOrderItem[]) {
        const lineTotal = item.quantity * item.unit_price;
        const lineTax = lineTotal * (item.tax_rate / 100);
        await sql`
          INSERT INTO supplier_purchase_order_items (
            purchase_order_id, description, quantity, unit_price, tax_rate,
            line_total, tax_amount
          ) VALUES (
            ${order.id}::UUID, ${item.description}, ${item.quantity},
            ${item.unit_price}, ${item.tax_rate},
            ${Math.round(lineTotal * 100) / 100},
            ${Math.round(lineTax * 100) / 100}
          )
        `;
      }

      const orderItems = await sql`
        SELECT * FROM supplier_purchase_order_items
        WHERE purchase_order_id = ${order.id}::UUID
        ORDER BY created_at ASC
      `;

      return apiResponse.created(res, { order, items: orderItems });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create purchase order';
      log.error('Failed to create purchase order', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  // ── PUT: Update (draft only) ───────────────────────────────────────────────
  if (req.method === 'PUT') {
    try {
      const {
        id, supplier_id, order_date, delivery_date, reference, notes, internal_notes, items,
      } = req.body;

      if (!id) {
        return apiResponse.badRequest(res, 'id is required');
      }

      // Verify draft status
      const existing = await sql`
        SELECT id, status FROM supplier_purchase_orders
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      `;

      if (existing.length === 0) {
        return apiResponse.notFound(res, 'Purchase order');
      }

      if (existing[0]!.status !== 'draft') {
        return apiResponse.badRequest(res, 'Only draft purchase orders can be updated');
      }

      // Calculate new totals if items provided
      let subtotal: number | undefined;
      let taxAmount: number | undefined;
      let totalAmount: number | undefined;

      if (items && Array.isArray(items) && items.length > 0) {
        const totals = calculateTotals(items);
        subtotal = totals.subtotal;
        taxAmount = totals.taxAmount;
        totalAmount = totals.totalAmount;
      }

      const updated = await sql`
        UPDATE supplier_purchase_orders SET
          supplier_id  = COALESCE(${supplier_id || null}::UUID, supplier_id),
          order_date   = COALESCE(${order_date || null}::DATE, order_date),
          delivery_date = COALESCE(${delivery_date || null}::DATE, delivery_date),
          reference    = COALESCE(${reference !== undefined ? reference : null}, reference),
          notes        = COALESCE(${notes !== undefined ? notes : null}, notes),
          internal_notes = COALESCE(${internal_notes !== undefined ? internal_notes : null}, internal_notes),
          subtotal     = COALESCE(${subtotal ?? null}, subtotal),
          tax_amount   = COALESCE(${taxAmount ?? null}, tax_amount),
          total_amount = COALESCE(${totalAmount ?? null}, total_amount),
          updated_at   = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
        RETURNING *
      `;

      // Replace items if provided
      if (items && Array.isArray(items) && items.length > 0) {
        await sql`
          DELETE FROM supplier_purchase_order_items WHERE purchase_order_id = ${id}::UUID
        `;

        for (const item of items as PurchaseOrderItem[]) {
          const lineTotal = item.quantity * item.unit_price;
          const lineTax = lineTotal * (item.tax_rate / 100);
          await sql`
            INSERT INTO supplier_purchase_order_items (
              purchase_order_id, description, quantity, unit_price, tax_rate,
              line_total, tax_amount
            ) VALUES (
              ${id}::UUID, ${item.description}, ${item.quantity},
              ${item.unit_price}, ${item.tax_rate},
              ${Math.round(lineTotal * 100) / 100},
              ${Math.round(lineTax * 100) / 100}
            )
          `;
        }
      }

      const orderItems = await sql`
        SELECT * FROM supplier_purchase_order_items
        WHERE purchase_order_id = ${id}::UUID
        ORDER BY created_at ASC
      `;

      return apiResponse.success(res, { order: updated[0], items: orderItems });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update purchase order';
      log.error('Failed to update purchase order', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  // ── DELETE: Remove (draft only) ────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const { id } = req.body;

      if (!id) {
        return apiResponse.badRequest(res, 'id is required');
      }

      const existing = await sql`
        SELECT id, status FROM supplier_purchase_orders
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      `;

      if (existing.length === 0) {
        return apiResponse.notFound(res, 'Purchase order');
      }

      if (existing[0]!.status !== 'draft') {
        return apiResponse.badRequest(res, 'Only draft purchase orders can be deleted');
      }

      await sql`
        DELETE FROM supplier_purchase_order_items WHERE purchase_order_id = ${id}::UUID
      `;

      await sql`
        DELETE FROM supplier_purchase_orders
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      `;

      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Failed to delete purchase order', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to delete purchase order');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
