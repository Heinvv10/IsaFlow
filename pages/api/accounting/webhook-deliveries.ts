/**
 * Webhook Deliveries API — WS-8.1
 * GET — delivery log (?webhook_id=X&limit=50)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getDeliveries } from '@/modules/accounting/services/webhookService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyApiRequest;
  const webhookId = req.query.webhook_id as string;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 500));

  if (!webhookId) return apiResponse.badRequest(res, 'webhook_id query param is required');

  try {
    const deliveries = await getDeliveries(companyId, webhookId, limit);
    return apiResponse.success(res, deliveries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    log.error('Webhook deliveries fetch failed', { webhookId, error: err }, 'webhook-deliveries-api');
    return apiResponse.badRequest(res, msg);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
