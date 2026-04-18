/**
 * Customer Payments API
 * GET  /api/accounting/customer-payments - List payments (with filters)
 * POST /api/accounting/customer-payments - Create payment with allocations
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
  getCustomerPayments,
  getCustomerPaymentById,
  createCustomerPayment,
} from '@/modules/accounting/services/ar/customerPaymentService';
import type { CustomerPaymentStatus } from '@/modules/accounting/types/ar.types';

const CreateCustomerPaymentSchema = z.object({
  clientId: UUID,
  paymentDate: ISODate,
  totalAmount: z.coerce.number().nonnegative().multipleOf(0.01),
  paymentMethod: z.enum(['eft', 'cheque', 'cash', 'card']).optional(),
  bankReference: z.string().max(200).optional(),
  bankAccountId: UUID.optional(),
  description: z.string().max(500).optional(),
  projectId: UUID.optional(),
  allocations: z.array(z.object({
    invoiceId: UUID,
    amount: z.coerce.number().nonnegative().multipleOf(0.01),
  })).min(1).max(200),
});

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { id, status, client_id, limit, offset } = req.query;

      // Single payment by ID
      if (id) {
        const payment = await getCustomerPaymentById(companyId, String(id));
        if (!payment) return apiResponse.notFound(res, 'Payment', String(id));
        return apiResponse.success(res, payment);
      }

      const result = await getCustomerPayments(companyId, {
        status: status as CustomerPaymentStatus | undefined,
        clientId: client_id ? String(client_id) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get customer payments', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get customer payments');
    }
  }

  if (req.method === 'POST') {
    const postParsed = CreateCustomerPaymentSchema.safeParse(req.body);
    if (!postParsed.success) {
      return apiResponse.validationError(res, postParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    try {
      const { clientId, paymentDate, totalAmount, paymentMethod, bankReference,
        bankAccountId, description, projectId, allocations } = postParsed.data;

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const payment = await createCustomerPayment(companyId, {
        clientId,
        paymentDate,
        totalAmount,
        paymentMethod: paymentMethod || 'eft',
        bankReference: bankReference || undefined,
        bankAccountId: bankAccountId || undefined,
        description: description || undefined,
        projectId: projectId || undefined,
        allocations: allocations.map((a: { invoiceId: string; amount: number }) => ({
          invoiceId: a.invoiceId,
          amount: a.amount,
        })),
      }, userId);

      return apiResponse.created(res, payment);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create customer payment';
      log.error('Failed to create customer payment', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
