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
import { apiResponse } from '@/lib/apiResponse';
import { getClientIp } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { redeliverWebhook } from '@/modules/admin/services/adminWebhookService';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  deliveryId: UUID.optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const idParsed = UUID.safeParse(req.query.id);
  if (!idParsed.success) return apiResponse.notFound(res, 'Webhook not found');
  const webhookId = idParsed.data;

  const bodyParsed = PostBody.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    return apiResponse.badRequest(res, bodyParsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const { deliveryId } = bodyParsed.data;

  let result: Awaited<ReturnType<typeof redeliverWebhook>>;
  try {
    result = await redeliverWebhook(webhookId, deliveryId);
  } catch (err) {
    log.error('Admin: redeliver webhook failed', { webhookId, deliveryId, error: err }, 'admin-webhooks-redeliver-api');
    return apiResponse.badRequestFromError(res, err, 'Redeliver failed');
  }
  // Outside the catch: a failed audit write is a 500, not a committed 4xx. It rolls back only the
  // delivery row (request transaction): the request has already gone out, and the endpoint stamp
  // (stampDelivery) committed on its own migration_admin connection.
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
