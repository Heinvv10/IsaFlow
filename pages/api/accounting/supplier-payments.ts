/**
 * Supplier Payments API
 * GET  /api/accounting/supplier-payments - List payments
 * POST /api/accounting/supplier-payments - Create payment with allocations
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID, ISODate } from '@/lib/schemas/common';
import {
  getSupplierPayments,
  getSupplierPaymentById,
  createSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentService';
import type { PaymentStatus } from '@/modules/accounting/types/ap.types';

const CreateSupplierPaymentSchema = z.object({
  supplierId: UUID,
  paymentDate: ISODate,
  totalAmount: z.coerce.number().nonnegative().multipleOf(0.01),
  paymentMethod: z.enum(['eft', 'cheque', 'cash', 'card']).optional(),
  bankAccountId: UUID.optional(),
  reference: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  allocations: z.array(z.object({
    invoiceId: UUID,
    amount: z.coerce.number().nonnegative().multipleOf(0.01),
  })).min(1).max(200),
});

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

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
        supplierId: supplier_id ? String(supplier_id) : undefined,
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
    const postParsed = CreateSupplierPaymentSchema.safeParse(req.body);
    if (!postParsed.success) {
      return apiResponse.validationError(res, postParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    try {
      const { supplierId, paymentDate, totalAmount, paymentMethod,
        bankAccountId, reference, description, allocations } = postParsed.data;

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const payment = await createSupplierPayment(companyId, {
        supplierId, paymentDate, totalAmount,
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

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
