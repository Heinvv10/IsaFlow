/**
 * Admin Webhook Redeliver API
 * POST /api/admin/webhooks/[id]/redeliver
 * Body: { deliveryId?: string } — omit to retry last failed delivery
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { redeliverWebhook } from '@/modules/admin/services/adminWebhookService';

function getIp(req: AuthenticatedNextApiRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const raw = Array.isArray(fwd) ? fwd[0] ?? '' : fwd;
    const ips = raw.split(',').map((s: string) => s.trim());
    return ips[ips.length - 1] ?? req.socket?.remoteAddress ?? 'unknown';
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const webhookId = req.query.id as string;
  if (!webhookId) return apiResponse.badRequest(res, 'id is required');

  const { deliveryId } = (req.body ?? {}) as { deliveryId?: string };

  try {
    const result = await redeliverWebhook(webhookId, deliveryId);
    await logAdminAction(
      req.user.id,
      'webhook.redeliver',
      'webhook',
      webhookId,
      { deliveryId: deliveryId ?? 'last_failed', newDeliveryId: result.deliveryId },
      getIp(req),
    );
    log.info('Admin: queued webhook redeliver', { webhookId, deliveryId }, 'admin-webhooks-redeliver-api');
    return apiResponse.success(res, result, 'Delivery queued for retry');
  } catch (err) {
    log.error('Admin: redeliver webhook failed', { webhookId, deliveryId, error: err }, 'admin-webhooks-redeliver-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Redeliver failed');
  }
}

export default withAdmin(handler);
