/**
 * Customer Payments API
 * GET  /api/accounting/customer-payments - List payments (with filters)
 * POST /api/accounting/customer-payments - Create payment with allocations
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getCustomerPayments,
  getCustomerPaymentById,
  createCustomerPayment,
} from '@/modules/accounting/services/customerPaymentService';
import type { CustomerPaymentStatus } from '@/modules/accounting/types/ar.types';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
    try {
      const { clientId, paymentDate, totalAmount, paymentMethod, bankReference,
        bankAccountId, description, projectId, allocations } = req.body;

      if (!clientId || !paymentDate || !totalAmount || !allocations || !Array.isArray(allocations)) {
        return apiResponse.badRequest(res, 'clientId, paymentDate, totalAmount, and allocations are required');
      }

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const payment = await createCustomerPayment(companyId, {
        clientId: String(clientId),
        paymentDate,
        totalAmount: Number(totalAmount),
        paymentMethod: paymentMethod || 'eft',
        bankReference: bankReference || undefined,
        bankAccountId: bankAccountId || undefined,
        description: description || undefined,
        projectId: projectId || undefined,
        allocations: allocations.map((a: { invoiceId: string; amount: number }) => ({
          invoiceId: String(a.invoiceId),
          amount: Number(a.amount),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
