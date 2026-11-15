/**
 * Admin Webhook Detail API
 * GET    /api/admin/webhooks/[id] — fetch webhook with last 20 deliveries
 * PATCH  /api/admin/webhooks/[id] — update status, url, events
 * DELETE /api/admin/webhooks/[id] — delete webhook
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { getClientIp } from '@/lib/rateLimit';
import { logAdminAction } from '@/modules/admin/services/auditService';
import {
  getAdminWebhookById,
  updateAdminWebhook,
  deleteAdminWebhook,
  type UpdateWebhookParams,
} from '@/modules/admin/services/adminWebhookService';

const PatchBody = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  url:    z.string().url().optional(),
  events: z.array(z.string().min(1)).optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = adminUuid(req.query.id);

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const webhook = await getAdminWebhookById(id);
    if (!webhook) return apiResponse.notFound(res, 'Webhook not found');
    return apiResponse.success(res, webhook);
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    const { status, url, events } = parsed.data as UpdateWebhookParams;

    const updated = await updateAdminWebhook(id, { status, url, events });
    await logAdminAction(
      req.user.id,
      'webhook.update',
      'webhook',
      id,
      { company_id: updated.companyId, status, url, events: events?.join(',') },
      getClientIp(req),
    );
    return apiResponse.success(res, updated);
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const webhook = await getAdminWebhookById(id);
    if (!webhook) return apiResponse.notFound(res, 'Webhook not found');

    // The DELETE decides, not the read above: of two concurrent deletes only one removes the row and is audited.
    if (!(await deleteAdminWebhook(id))) return apiResponse.notFound(res, 'Webhook not found');
    await logAdminAction(
      req.user.id,
      'webhook.delete',
      'webhook',
      id,
      { company_id: webhook.companyId, url: webhook.url },
      getClientIp(req),
    );
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(handler);
