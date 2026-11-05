/**
 * Admin Webhook Redeliver API
 * POST /api/admin/webhooks/[id]/redeliver
 * Body: { deliveryId?: string } — omit to retry last failed delivery
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
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

  const webhookId = req.query.id as string;
  if (!webhookId) return apiResponse.badRequest(res, 'id is required');

  const bodyParsed = PostBody.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    return apiResponse.badRequest(res, bodyParsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const { deliveryId } = bodyParsed.data;

  try {
    const result = await redeliverWebhook(webhookId, deliveryId);
    await logAdminAction(
      req.user.id,
      'webhook.redeliver',
      'webhook',
      webhookId,
      { deliveryId: deliveryId ?? 'last_failed', newDeliveryId: result.deliveryId },
      getClientIp(req),
    );
    log.info('Admin: queued webhook redeliver', { webhookId, deliveryId }, 'admin-webhooks-redeliver-api');
    return apiResponse.success(res, result, 'Delivery queued for retry');
  } catch (err) {
    log.error('Admin: redeliver webhook failed', { webhookId, deliveryId, error: err }, 'admin-webhooks-redeliver-api');
    return apiResponse.badRequestFromError(res, err, 'Redeliver failed');
  }
}

export default withAdmin(handler);
