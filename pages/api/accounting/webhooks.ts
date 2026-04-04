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
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
} from '@/modules/accounting/services/webhookService';

/** SSRF guard — only allow HTTPS URLs pointing to public internet hosts */
function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return false;
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) return false;
    if (hostname === '169.254.169.254') return false; // AWS metadata endpoint
    return true;
  } catch { return false; }
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
    if (!isValidWebhookUrl(url)) {
      return apiResponse.badRequest(res, 'Webhook URL must be a valid HTTPS URL pointing to a public host');
    }
    try {
      const item = await createWebhook(companyId, { name, url, secret, events, isActive });
      return apiResponse.success(res, item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Webhook create failed', { error: err }, 'webhooks-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body as { id?: string; [key: string]: unknown };
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      const item = await updateWebhook(companyId, id, updates as Parameters<typeof updateWebhook>[2]);
      return apiResponse.success(res, item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      log.error('Webhook update failed', { error: err }, 'webhooks-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string;
    if (!id) return apiResponse.badRequest(res, 'id query param is required');
    try {
      await deleteWebhook(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      log.error('Webhook delete failed', { error: err }, 'webhooks-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
