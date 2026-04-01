/**
 * Supplier Payments API
 * GET  /api/accounting/supplier-payments - List payments
 * POST /api/accounting/supplier-payments - Create payment with allocations
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getSupplierPayments,
  getSupplierPaymentById,
  createSupplierPayment,
} from '@/modules/accounting/services/supplierPaymentService';
import type { PaymentStatus } from '@/modules/accounting/types/ap.types';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const { id, status, supplier_id, limit, offset } = req.query;

      // Single payment by ID
      if (id) {
        const payment = await getSupplierPaymentById(companyId, id as string);
        if (!payment) return apiResponse.notFound(res, 'Payment', id as string);
        return apiResponse.success(res, payment);
      }

      const result = await getSupplierPayments(companyId, {
        status: status as PaymentStatus | undefined,
        supplierId: supplier_id ? Number(supplier_id) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get supplier payments', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to get supplier payments');
    }
  }

  if (req.method === 'POST') {
    try {
      const { supplierId, paymentDate, totalAmount, paymentMethod,
        bankAccountId, reference, description, allocations } = req.body;

      if (!supplierId || !paymentDate || !totalAmount || !allocations || !Array.isArray(allocations)) {
        return apiResponse.badRequest(res, 'supplierId, paymentDate, totalAmount, and allocations are required');
      }

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const payment = await createSupplierPayment(companyId, {
        supplierId: Number(supplierId),
        paymentDate, totalAmount: Number(totalAmount),
        paymentMethod, bankAccountId, reference, description,
        allocations,
      }, userId);

      return apiResponse.created(res, payment);
    } catch (err) {
      log.error('Failed to create supplier payment', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to create payment');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
