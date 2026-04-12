/**
 * Admin Webhook Detail API
 * GET    /api/admin/webhooks/[id] — fetch webhook with last 20 deliveries
 * PATCH  /api/admin/webhooks/[id] — update status, url, events
 * DELETE /api/admin/webhooks/[id] — delete webhook
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import {
  getAdminWebhookById,
  updateAdminWebhook,
  deleteAdminWebhook,
  type UpdateWebhookParams,
} from '@/modules/admin/services/adminWebhookService';

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
  const id = req.query.id as string;
  if (!id) return apiResponse.badRequest(res, 'id is required');

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const webhook = await getAdminWebhookById(id);
      if (!webhook) return apiResponse.notFound(res, 'Webhook not found');
      return apiResponse.success(res, webhook);
    } catch (err) {
      log.error('Admin: failed to get webhook', { id, error: err }, 'admin-webhooks-id-api');
      return apiResponse.badRequest(res, 'Failed to get webhook');
    }
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { status, url, events } = req.body as UpdateWebhookParams;

    const validStatuses = ['active', 'disabled'] as const;
    if (status !== undefined && !validStatuses.includes(status)) {
      return apiResponse.badRequest(res, 'status must be "active" or "disabled"');
    }

    try {
      const updated = await updateAdminWebhook(id, { status, url, events });
      await logAdminAction(
        req.user.id,
        'webhook.update',
        'webhook',
        id,
        { status, url, events: events?.join(',') },
        getIp(req),
      );
      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Admin: failed to update webhook', { id, error: err }, 'admin-webhooks-id-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Update failed');
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const webhook = await getAdminWebhookById(id);
      if (!webhook) return apiResponse.notFound(res, 'Webhook not found');

      await deleteAdminWebhook(id);
      await logAdminAction(
        req.user.id,
        'webhook.delete',
        'webhook',
        id,
        { companyId: webhook.companyId, url: webhook.url },
        getIp(req),
      );
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Admin: failed to delete webhook', { id, error: err }, 'admin-webhooks-id-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(handler);
