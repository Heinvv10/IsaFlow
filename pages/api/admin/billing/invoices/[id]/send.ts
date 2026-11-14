/**
 * Admin Billing Invoice Send API
 * POST /api/admin/billing/invoices/[id]/send — email a draft invoice to the company's billing email, then mark it sent.
 *
 * Claim -> email -> finalise, each committed on its own (services/invoiceSendService.ts, migration 991): no
 * lock or transaction of this route is open across the SMTP call, and an email that left is never erased.
 *   404 no such invoice; 409 not a draft, or a send is in flight / its outcome is unknown (the claim);
 *   422 the company has no single valid billing email;
 *   424 the mail server refused it (claim released, still draft, retry is safe), or did not confirm it
 *       (claim KEPT: the email may have left, so nothing re-sends it until someone checks the email log);
 *   500 the email left but the finalise failed (claim kept, as above).
 * `sent: true` is answered only after the status changed to 'sent'.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  claimInvoiceForSend, emailInvoice, finaliseInvoiceSent, releaseInvoiceClaim, type SendActor,
} from '@/modules/admin/services/invoiceSendService';
import { withOwnPlatformAdminTx } from '@/lib/auth/platformAdminOwnTx';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { requireCtx } from '@/lib/als';

const UNKNOWN_OUTCOME = 'A send of this invoice is in progress or its outcome is unknown. Check the email log before sending it again';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const parsedId = UUID.safeParse(req.query.id);
  if (!parsedId.success) return apiResponse.badRequest(res, 'Invoice id must be a valid id');
  const id = parsedId.data;
  // The request's own claims (withPlatformAdmin's context), so the claim/finalise transactions record the same actor.
  const actor: SendActor = { userId: req.user.id, claims: requireCtx().claims, ip: getIp(req) };

  let claim;
  try {
    claim = await claimInvoiceForSend(id, actor);
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
  if (!claim.ok) {
    if (claim.reason === 'not_found') return apiResponse.notFound(res, 'Invoice not found');
    if (claim.reason === 'in_progress') return apiResponse.conflict(res, `${claim.invoice_number}: ${UNKNOWN_OUTCOME}`);
    if (claim.reason === 'wrong_status') {
      return apiResponse.conflict(res, `Invoice ${claim.invoice_number} is ${claim.status}; only a draft can be sent`);
    }
    return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION,
      `${claim.company_name} has no valid billing email; add one on the company before sending`);
  }
  const invoice = claim.invoice;

  const result = await emailInvoice(invoice, actor.userId);
  if (!result.success && result.provablyNotSent) {
    log.warn('Invoice email refused; claim released', { id, error: result.error }, 'admin-api');
    await releaseInvoiceClaim(invoice, actor, result.error ?? 'unknown');
    return apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      'The invoice email could not be sent; it is still a draft. Try again later');
  }
  if (!result.success) {
    // The mail server may have taken it (a timeout mid-conversation proves nothing): the claim stays.
    log.error('Invoice email outcome unknown; claim kept', { id, error: result.error }, 'admin-api');
    await withOwnPlatformAdminTx(actor, () => logAdminAction(actor.userId, 'invoice.send_unknown', 'invoice', id,
      { recipient: invoice.billing_email, invoice_number: invoice.invoice_number, error: result.error ?? 'unknown' }, actor.ip));
    return apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      `The mail server did not confirm the email to ${invoice.billing_email}. ${UNKNOWN_OUTCOME}`);
  }

  try {
    await finaliseInvoiceSent(invoice, actor, result.messageId ?? null);
  } catch (err) {
    // The email left; the claim stays, so nothing re-sends it. A 5xx, with words that do not invite a retry.
    log.error('Invoice emailed but not marked sent; claim kept', { id, error: err instanceof Error ? err.message : String(err) }, 'admin-api');
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR,
      `The email to ${invoice.billing_email} was sent, but marking ${invoice.invoice_number} sent failed. ${UNKNOWN_OUTCOME}`);
  }
  return apiResponse.success(res, { sent: true, recipient: invoice.billing_email, message_id: result.messageId ?? null });
}

export default withAdmin(withCsrf(handler));
