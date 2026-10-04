/**
 * POST /api/accounting/customer-invoices/[id]/payment-link/revoke
 *
 * Cancels every active standing "Pay now" link on the invoice and clears `payment_url` /
 * `online_payment_enabled`; the next Pay Now mints a fresh link. Explicit-amount links and any
 * checkout already open at Paystack are untouched: a payment already started still settles.
 *
 * Response: { revoked: true, cancelled: <links cancelled> } (0 when only a dead payment_url was
 * cleared). 404 'No active payment link' when there is nothing to do.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { revokeStandingLink } from '@/modules/accounting/services/ar/standingPaymentLink';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const invoiceId = req.query.id;
  if (!invoiceId) return apiResponse.badRequest(res, 'invoice id required');
  if (!isUuidParam(invoiceId)) return apiResponse.badRequest(res, 'invoice id must be a UUID');

  let result: Awaited<ReturnType<typeof revokeStandingLink>>;
  try {
    result = await revokeStandingLink(companyId, invoiceId);
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
  if (!result.ok) {
    return result.reason === 'invoice_not_found'
      ? apiResponse.notFound(res, 'Invoice')
      : apiResponse.error(res, ErrorCode.NOT_FOUND, 'No active payment link');
  }
  log.info('Standing payment link revoked', { companyId, invoiceId, userId: user.id, cancelled: result.cancelled }, 'PaymentLink');
  return apiResponse.success(res, { revoked: true, cancelled: result.cancelled });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
