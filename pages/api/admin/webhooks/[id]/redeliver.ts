/**
 * Admin Webhook Redeliver API
 * POST /api/admin/webhooks/[id]/redeliver
 * Body: { deliveryId?: string } — omit to re-send this webhook's last failed delivery.
 * Sends now (adminWebhookService.redeliverWebhook); `data.delivered` says whether the endpoint accepted it.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { withCsrf } from '@/lib/auth/withCsrf';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { AdminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { getClientIp } from '@/lib/rateLimit';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { redeliverWebhook } from '@/modules/admin/services/adminWebhookService';

const PostBody = z.object({
  deliveryId: AdminUuid.optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const idParsed = AdminUuid.safeParse(req.query.id);
  if (!idParsed.success) return apiResponse.notFound(res, 'Webhook not found');
  const webhookId = idParsed.data;

  const bodyParsed = PostBody.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    return apiResponse.badRequest(res, bodyParsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const { deliveryId } = bodyParsed.data;

  // A missing or disabled webhook, or no delivery to resend, is an AdminRequestError (404 / 409) raised before
  // anything is sent; anything else is a 500. A failed audit write below is a 500 too. It rolls back only the
  // delivery row (request transaction): the request has already gone out, and the endpoint stamp
  // (stampDelivery) committed on its own migration_admin connection.
  const result = await redeliverWebhook(webhookId, deliveryId);
  await logAdminAction(
    req.user.id,
    'webhook.redeliver',
    'webhook',
    webhookId,
    {
      deliveryId: deliveryId ?? 'last_failed', newDeliveryId: result.deliveryId,
      delivered: result.delivered, responseStatus: result.responseStatus,
    },
    getClientIp(req),
  );
  const answer = result.responseStatus === null ? 'no answer' : `HTTP ${result.responseStatus}`;
  return apiResponse.success(res, result,
    result.delivered ? `Redelivered (${answer})` : `Redelivery failed: the endpoint gave ${answer}`);
}

export default withAdmin(withCsrf(handler));
