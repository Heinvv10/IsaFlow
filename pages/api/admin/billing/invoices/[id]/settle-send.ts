/**
 * Admin Billing Invoice Settle Send API
 * POST /api/admin/billing/invoices/[id]/settle-send — settle a Send whose outcome is unknown (the claim of migration 991).
 * Body: { outcome: 'sent' | 'released' }. The admin reads the email log first:
 *   'sent'      it was delivered: status 'sent', claim cleared;
 *   'released'  it was not: claim cleared, the draft can be sent again.
 * Audited `invoice.send_settled` { outcome }. 404 no such invoice; 409 no claim to settle (not a claimed draft), or
 * the claim is younger than SEND_SETTLE_AFTER_MS (10 min, well above the 45 s hard send deadline): the send may still be in flight.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { UUID } from '@/lib/schemas/common';
import { settleInvoiceSend } from '@/modules/admin/services/invoiceSendService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({ outcome: z.enum(['sent', 'released']) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const parsedId = UUID.safeParse(req.query.id);
  if (!parsedId.success) return apiResponse.badRequest(res, 'Invoice id must be a valid id');
  const body = PostBody.safeParse(req.body);
  if (!body.success) return apiResponse.badRequest(res, "outcome: must be 'sent' or 'released'");

  const result = await settleInvoiceSend(parsedId.data, body.data.outcome, req.user.id, getIp(req));
  if (!result.ok && result.reason === 'not_found') return apiResponse.notFound(res, 'Invoice not found');
  if (!result.ok && result.reason === 'too_fresh') {
    return apiResponse.conflict(res, 'This send is still in progress; try again shortly');
  }
  if (!result.ok) return apiResponse.conflict(res, 'This invoice has no send to settle (it is not a draft awaiting a send outcome)');
  return apiResponse.success(res, { settled: true, outcome: body.data.outcome, invoice_number: result.invoice_number });
}

export default withAdmin(withCsrf(handler));
