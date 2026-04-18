/**
 * Recurring Transactions Execute API — WS-8.4
 * POST — execute a template immediately
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { templateId } = req.body as { templateId?: string };
  if (!templateId) return apiResponse.badRequest(res, 'templateId is required');

  const userId = req.user.id;
  try {
    const result = await executeRecurring(companyId, templateId, userId);
    return apiResponse.success(res, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Execute failed';
    log.error('Recurring execute failed', { templateId, error: err }, 'recurring-execute-api');
    return apiResponse.badRequest(res, msg);
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
