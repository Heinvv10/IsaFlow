/**
 * Payment Gateway API — gateway-agnostic invoice payment toggle.
 *
 * POST { invoiceId, action: 'enable' } — enable online payments for an
 *   invoice. Generates a portal_payment_links token and stores
 *   `online_payment_enabled = true` + the public payment URL on the invoice.
 *   The customer-facing portal at /portal/pay/[token] then offers Paystack
 *   as the payment method.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { enableOnlinePayment } from '@/modules/accounting/services/core/paymentGatewayPortalService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { invoiceId, action } = req.body ?? {};

  if (!invoiceId) return apiResponse.badRequest(res, 'invoiceId is required');
  if (action !== 'enable') {
    return apiResponse.badRequest(res, 'Only action=enable is supported on this endpoint');
  }

  const paymentUrl = await enableOnlinePayment(companyId, invoiceId);
  return apiResponse.success(res, { paymentUrl });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
