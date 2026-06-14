/**
 * Webhooks API — WS-8.1
 * GET  — list webhooks
 * POST — create webhook
 * PUT  — update webhook (body includes id)
 * DELETE — delete webhook (?id=X)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { checkPublicUrl } from '@/lib/safeFetch';
import {
  getWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
} from '@/modules/accounting/services/core/webhookService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const items = await getWebhooks(companyId);
    return apiResponse.success(res, items);
  }

  if (req.method === 'POST') {
    const { name, url, secret, events, isActive } = req.body as {
      name?: string; url?: string; secret?: string; events?: string[]; isActive?: boolean;
    };
    if (!name || !url || !events || events.length === 0) {
      return apiResponse.badRequest(res, 'name, url, and at least one event are required');
    }
    const urlReason = await checkPublicUrl(url);
    if (urlReason) {
      return apiResponse.badRequest(res, `Webhook URL must be a public HTTPS endpoint (${urlReason})`);
    }
    try {
      const item = await createWebhook(companyId, { name, url, secret, events, isActive });
      return apiResponse.success(res, item);
    } catch (err) {
      log.error('Webhook create failed', { error: err }, 'webhooks-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body as { id?: string; [key: string]: unknown };
    if (!id) return apiResponse.badRequest(res, 'id is required');
    // H2: validate the URL on UPDATE too — the old code only checked it on create,
    // so an attacker could create a benign webhook then PUT an internal URL.
    if (typeof updates.url === 'string') {
      const urlReason = await checkPublicUrl(updates.url);
      if (urlReason) {
        return apiResponse.badRequest(res, `Webhook URL must be a public HTTPS endpoint (${urlReason})`);
      }
    }
    try {
      const item = await updateWebhook(companyId, id, updates as Parameters<typeof updateWebhook>[2]);
      return apiResponse.success(res, item);
    } catch (err) {
      log.error('Webhook update failed', { error: err }, 'webhooks-api');
      return apiResponse.badRequestFromError(res, err, 'Update failed');
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string;
    if (!id) return apiResponse.badRequest(res, 'id query param is required');
    try {
      await deleteWebhook(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Webhook delete failed', { error: err }, 'webhooks-api');
      return apiResponse.badRequestFromError(res, err, 'Delete failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
