/**
 * Payment Gateway API
 * GET  ?invoiceId= — get payment form data for an invoice
 * GET  ?transactionId= — get payment transaction status
 * POST { invoiceId } — generate payment form data
 * POST { invoiceId, action: 'enable' } — enable online payments for an invoice
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import {
  generatePayFastForm,
  getPaymentStatus,
  getInvoicePayments,
  enableOnlinePayment,
} from '@/modules/accounting/services/paymentGatewayService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3101';

  if (req.method === 'GET') {
    const { invoiceId, transactionId } = req.query;

    if (transactionId) {
      const tx = await getPaymentStatus(companyId, transactionId as string);
      if (!tx) return apiResponse.notFound(res, 'Payment transaction');
      return apiResponse.success(res, tx);
    }

    if (invoiceId) {
      const payments = await getInvoicePayments(companyId, invoiceId as string);
      return apiResponse.success(res, payments);
    }

    return apiResponse.badRequest(res, 'invoiceId or transactionId is required');
  }

  if (req.method === 'POST') {
    const { invoiceId, action, returnUrl, cancelUrl } = req.body;
    if (!invoiceId) return apiResponse.badRequest(res, 'invoiceId is required');

    if (action === 'enable') {
      const paymentUrl = await enableOnlinePayment(companyId, invoiceId);
      return apiResponse.success(res, { paymentUrl });
    }

    // Generate PayFast form
    const notifyUrl = `${appUrl}/api/accounting/payment-gateway-itn`;
    const formData = await generatePayFastForm(
      companyId,
      invoiceId,
      returnUrl || `${appUrl}/portal/pay/success`,
      cancelUrl || `${appUrl}/portal/pay/cancelled`,
      notifyUrl,
    );
    return apiResponse.success(res, formData);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
