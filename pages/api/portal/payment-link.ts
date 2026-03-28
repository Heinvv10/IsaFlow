/**
 * Client Portal — Payment Link API
 * GET  — get payment link details by token
 * POST — create a new payment link for an invoice
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { createPaymentLink, getPaymentLink } from '@/modules/accounting/services/portalService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const token = req.query.token as string;
    if (!token) return apiResponse.badRequest(res, 'token is required');
    const link = await getPaymentLink(token);
    if (!link) return apiResponse.notFound(res, 'Payment link');
    return apiResponse.success(res, link);
  }

  if (req.method === 'POST') {
    const { invoiceId, clientId, amount } = req.body;
    if (!invoiceId || !clientId || !amount) {
      return apiResponse.badRequest(res, 'invoiceId, clientId, and amount are required');
    }
    const token = await createPaymentLink(invoiceId, clientId, Number(amount));
    return apiResponse.success(res, { token, url: `/portal/pay/${token}` });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
