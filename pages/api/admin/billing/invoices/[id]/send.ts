/**
 * Admin Billing Invoice Send API
 * POST /api/admin/billing/invoices/[id]/send — email a draft invoice to the company's billing email, then mark it sent.
 *
 * 404 no such invoice; 409 not a draft (already sent, paid, ...); 422 the company has no usable billing email;
 * 424 the mail server refused or could not be reached (the invoice stays draft; email_log keeps the failed
 * attempt and an `invoice.send_failed` audit row says so). The `invoice.send` audit row is written BEFORE the
 * email goes out (src/modules/admin/.claude.md: external call after the audit write).
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { emailInvoice, isSingleEmailAddress, lockInvoiceForSend, markInvoiceSent } from '@/modules/admin/services/invoiceSendService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const parsedId = UUID.safeParse(req.query.id);
  if (!parsedId.success) return apiResponse.badRequest(res, 'Invoice id must be a valid id');
  const id = parsedId.data;

  const invoice = await lockInvoiceForSend(id);
  if (!invoice) return apiResponse.notFound(res, 'Invoice not found');
  if (invoice.status !== 'draft') {
    return apiResponse.conflict(res, `Invoice ${invoice.invoice_number} is ${invoice.status}; only a draft can be sent`);
  }
  const recipient = invoice.billing_email;
  if (!recipient || !isSingleEmailAddress(recipient)) {
    return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION,
      `${invoice.company_name} has no valid billing email; add one on the company before sending`);
  }

  await logAdminAction(req.user.id, 'invoice.send', 'invoice', id,
    { recipient, invoice_number: invoice.invoice_number, total_cents: invoice.total_cents }, getIp(req));

  const result = await emailInvoice({ ...invoice, billing_email: recipient }, req.user.id);
  if (!result.success) {
    log.warn('Invoice email not sent', { id, error: result.error }, 'admin-api');
    await logAdminAction(req.user.id, 'invoice.send_failed', 'invoice', id,
      { recipient, invoice_number: invoice.invoice_number, error: result.error ?? 'unknown' }, getIp(req));
    // 4xx, not 5xx: the request commits, so the failed email_log row and the audit rows stay.
    return apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      'The invoice email could not be sent; it is still a draft. Try again later');
  }

  await markInvoiceSent(id);
  return apiResponse.success(res, { sent: true, recipient, message_id: result.messageId ?? null });
}

export default withAdmin(withCsrf(handler));
