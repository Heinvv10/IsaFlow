/**
 * Webhook Test API — WS-8.1
 * POST — send a test payload to a webhook endpoint
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { testWebhook } from '@/modules/accounting/services/webhookService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyApiRequest;
  const { webhookId } = req.body as { webhookId?: string };
  if (!webhookId) return apiResponse.badRequest(res, 'webhookId is required');

  try {
    const result = await testWebhook(companyId, webhookId);
    return apiResponse.success(res, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Test failed';
    log.error('Webhook test failed', { webhookId, error: err }, 'webhooks-test-api');
    return apiResponse.badRequest(res, msg);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
