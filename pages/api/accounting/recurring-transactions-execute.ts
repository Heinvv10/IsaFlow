/**
 * Recurring Transactions Execute API — WS-8.4
 * POST — execute a template immediately
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';
import { RecurringTemplateNotFoundError } from '@/modules/accounting/services/core/recurringTransactionErrors';

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
    log.error('Recurring execute failed', { templateId, error: err }, 'recurring-execute-api');
    // ONLY the pre-write failure may be answered with a 4xx. `withAuth` COMMITs
    // the request transaction on a 4xx and ROLLBACKs only on a 5xx, so the old
    // blanket `badRequestFromError` committed whatever a half-finished run had
    // already written — and, on a numbering clash, silently threw away the
    // reservation so the next run failed identically forever.
    if (err instanceof RecurringTemplateNotFoundError) {
      return apiResponse.notFound(res, 'Active recurring template', templateId);
    }
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
