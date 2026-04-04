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
import {
  getPurchaseOrder,
  listPurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
} from '@/modules/accounting/services/purchaseOrderService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { id, status, search, limit, offset } = req.query;

      if (id) {
        const result = await getPurchaseOrder(String(id), companyId);
        if (!result) return apiResponse.notFound(res, 'Purchase order');
        return apiResponse.success(res, result);
      }

      const result = await listPurchaseOrders({
        companyId,
        status: status ? String(status) : null,
        search: search ? String(search) : null,
        limit: Number(limit) || 100,
        offset: Number(offset) || 0,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get purchase orders', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get purchase orders');
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { supplier_id, order_date, delivery_date, reference, notes, internal_notes, items } =
        req.body;

      if (!supplier_id || !order_date || !Array.isArray(items) || items.length === 0) {
        return apiResponse.badRequest(
          res,
          'supplier_id, order_date, and at least one item are required'
        );
      }

      const result = await createPurchaseOrder({
        companyId,
        userId: req.user.id,
        supplier_id,
        order_date,
        delivery_date: delivery_date ?? null,
        reference: reference ?? null,
        notes: notes ?? null,
        internal_notes: internal_notes ?? null,
        items,
      });

      return apiResponse.created(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create purchase order';
      log.error('Failed to create purchase order', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  // ── PUT ───────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    try {
      const { id, supplier_id, order_date, delivery_date, reference, notes, internal_notes, items } =
        req.body;

      if (!id) return apiResponse.badRequest(res, 'id is required');

      const result = await updatePurchaseOrder({
        id,
        companyId,
        supplier_id: supplier_id ?? null,
        order_date: order_date ?? null,
        delivery_date: delivery_date ?? null,
        reference: reference !== undefined ? reference : null,
        notes: notes !== undefined ? notes : null,
        internal_notes: internal_notes !== undefined ? internal_notes : null,
        items: Array.isArray(items) && items.length > 0 ? items : undefined,
      });

      if ('error' in result) {
        if (result.error === 'not_found') return apiResponse.notFound(res, 'Purchase order');
        return apiResponse.badRequest(res, 'Only draft purchase orders can be updated');
      }

      return apiResponse.success(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update purchase order';
      log.error('Failed to update purchase order', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const { id } = req.body;
      if (!id) return apiResponse.badRequest(res, 'id is required');

      const result = await deletePurchaseOrder(id, companyId);

      if ('error' in result) {
        if (result.error === 'not_found') return apiResponse.notFound(res, 'Purchase order');
        return apiResponse.badRequest(res, 'Only draft purchase orders can be deleted');
      }

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to delete purchase order', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to delete purchase order');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
