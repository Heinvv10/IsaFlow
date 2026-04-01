/**
 * Customer Sales Orders API
 * GET  — list orders (search, status, limit, offset)
 * GET  — get single order (?id=UUID) with items
 * POST — create order
 * PUT  — update order (draft only, requires id in body)
 * DELETE — delete order (draft only, requires id in body)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  getSalesOrders,
  getSalesOrder,
  createSalesOrder,
  updateSalesOrder,
  deleteSalesOrder,
} from '@/modules/accounting/services/salesOrderService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { id, status, search, limit, offset } = req.query;
    if (id) {
      const order = await getSalesOrder(companyId, id as string);
      if (!order) return apiResponse.notFound(res, 'Sales Order', id as string);
      return apiResponse.success(res, order);
    }
    const result = await getSalesOrders(companyId, {
      status: status as string,
      search: search as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;
    const order = await createSalesOrder(companyId, req.body, userId);
    return apiResponse.created(res, order);
  }

  if (req.method === 'PUT') {
    const { id, ...input } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const order = await updateSalesOrder(companyId, id, input);
    if (!order) return apiResponse.badRequest(res, 'Sales order not found or not in draft status');
    return apiResponse.success(res, order);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const deleted = await deleteSalesOrder(companyId, id);
    if (!deleted) return apiResponse.badRequest(res, 'Sales order not found or not in draft status');
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
