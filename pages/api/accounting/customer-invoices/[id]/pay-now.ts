/**
 * POST /api/accounting/customer-invoices/[id]/pay-now
 *
 * One-click "Pay Now" for an open customer invoice. Makes sure the invoice has its
 * standing payment link (one per invoice; charges the live balance, never expires)
 * and answers with it. The page then starts the Paystack checkout from that link
 * through the public POST /api/portal/payments/paystack/create, exactly as the
 * customer would.
 *
 * R-177: this route no longer calls Paystack. It did so inside its request
 * transaction, which held a connection across an unbounded gateway call, read the
 * balance in float, and opened a new payable checkout on every click.
 *
 * Response: { token, paymentUrl }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { ensureStandingLink } from '@/modules/accounting/services/ar/standingPaymentLink';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const invoiceId = req.query.id;
  if (!invoiceId) return apiResponse.badRequest(res, 'invoice id required');
  // R-158: type-checked, so neither 'x' nor ['<uuid>'] reaches the ::UUID cast.
  if (!isUuidParam(invoiceId)) return apiResponse.badRequest(res, 'invoice id must be a UUID');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl || /localhost|127\.0\.0\.1|\[::1\]/.test(appUrl)) {
    log.error(
      'NEXT_PUBLIC_APP_URL missing or points at localhost — refusing to generate portal URL',
      { appUrl },
      'PayNow',
    );
    return apiResponse.internalError(res, 'Server URL misconfigured');
  }

  // Every refusal comes before the first write (withAuth COMMITs a 4xx).
  const link = await ensureStandingLink(companyId, invoiceId, appUrl);
  if (!link.ok) {
    switch (link.reason) {
      case 'invoice_not_found': return apiResponse.notFound(res, 'Invoice');
      case 'invoice_draft': return apiResponse.badRequest(res, 'A draft invoice cannot be paid online. Approve it first.');
      case 'no_customer': return apiResponse.badRequest(res, 'Invoice has no linked customer');
      case 'nothing_owed': return apiResponse.badRequest(res, 'Invoice has no outstanding balance');
    }
  }
  return apiResponse.success(res, { token: link.token, paymentUrl: link.paymentUrl });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
