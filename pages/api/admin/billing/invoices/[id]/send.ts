/**
 * Admin Billing Invoice Send API
 * POST /api/admin/billing/invoices/[id]/send — email a draft invoice to the company's billing email, then mark it sent.
 * Body: { confirmed_to } — the address the confirm dialog showed; a billing email changed since then is refused.
 *
 * Claim -> email -> finalise, each committed on its own (services/invoiceSendService.ts, migration 991). The
 * request's own transaction and pool connection stay open (idle) across the SMTP call, holding no row lock and
 * no write of this flow, so an email that left is never erased by this request rolling back.
 *   404 no such invoice; 409 not a draft, the billing email changed, or a send is in flight / its outcome is
 *       unknown (the claim: the list shows it and an admin settles it via settle-send.ts);
 *   422 the company has no single valid billing email;
 *   424 the mail server refused it (claim released, still draft, retry is safe), or did not confirm it
 *       (claim KEPT: the email may have left, so nothing re-sends it until an admin settles it);
 *   500 the email could not be prepared (claim released, still draft), or it left but the finalise failed
 *       (claim kept, as above).
 * `sent: true` is answered only after the status changed to 'sent'.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  claimInvoiceForSend, emailInvoice, finaliseInvoiceSent, InvoiceEmailNotStartedError, recordSendUnknown, releaseInvoiceClaim,
} from '@/modules/admin/services/invoiceSendService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({ confirmed_to: z.string().max(320) }).strict();
const UNKNOWN_OUTCOME = 'A send of this invoice is in progress or its outcome is unknown. Check the email log, then settle it from the invoice list';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const parsedId = UUID.safeParse(req.query.id);
  if (!parsedId.success) return apiResponse.badRequest(res, 'Invoice id must be a valid id');
  const body = PostBody.safeParse(req.body);
  if (!body.success) return apiResponse.badRequest(res, 'confirmed_to: the address the confirm dialog showed is required');
  const id = parsedId.data;
  const ip = getIp(req);

  let claim;
  try {
    claim = await claimInvoiceForSend(id, body.data.confirmed_to, ip);
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
  if (!claim.ok) {
    if (claim.reason === 'not_found') return apiResponse.notFound(res, 'Invoice not found');
    if (claim.reason === 'in_progress') return apiResponse.conflict(res, `${claim.invoice_number}: ${UNKNOWN_OUTCOME}`);
    if (claim.reason === 'recipient_changed') {
      return apiResponse.conflict(res, `The billing email changed to ${claim.billing_email}; reopen the invoice and confirm again`);
    }
    if (claim.reason === 'wrong_status') {
      return apiResponse.conflict(res, `Invoice ${claim.invoice_number} is ${claim.status}; only a draft can be sent`);
    }
    return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION,
      `${claim.company_name} has no valid billing email; add one on the company before sending`);
  }
  const invoice = claim.invoice;

  let result;
  try {
    result = await emailInvoice(invoice, req.user.id);
  } catch (err) {
    if (!(err instanceof InvoiceEmailNotStartedError)) throw err; // may have reached the mail server: the claim stays
    log.error('Invoice email not prepared; claim released', { id, error: err.message }, 'admin-api');
    await releaseInvoiceClaim(invoice, ip, err.message);
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'The invoice email could not be prepared; it is still a draft');
  }
  if (!result.success && result.provablyNotSent) {
    log.warn('Invoice email refused; claim released', { id, error: result.error }, 'admin-api');
    await releaseInvoiceClaim(invoice, ip, result.error ?? 'unknown');
    return apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      'The invoice email could not be sent; it is still a draft. Try again later');
  }
  if (!result.success) {
    // The mail server may have taken it (a timeout mid-conversation proves nothing): the claim stays.
    log.error('Invoice email outcome unknown; claim kept', { id, error: result.error }, 'admin-api');
    await recordSendUnknown(invoice, ip, result.error ?? 'unknown');
    return apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      `The mail server did not confirm the email to ${invoice.billing_email}. ${UNKNOWN_OUTCOME}`);
  }

  try {
    await finaliseInvoiceSent(invoice, ip, result.messageId ?? null);
  } catch (err) {
    // The email left; the claim stays, so nothing re-sends it. A 5xx, with words that do not invite a retry.
    log.error('Invoice emailed but not marked sent; claim kept', { id, error: err instanceof Error ? err.message : String(err) }, 'admin-api');
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR,
      `The email to ${invoice.billing_email} was sent, but marking ${invoice.invoice_number} sent failed. ${UNKNOWN_OUTCOME}`);
  }
  return apiResponse.success(res, { sent: true, recipient: invoice.billing_email, message_id: result.messageId ?? null });
}

export default withAdmin(withCsrf(handler));
