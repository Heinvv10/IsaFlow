/**
 * Practice Task Recurring Instance API
 * POST — generate next recurring instance from a source task
 *        body: { sourceTaskId: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { generateNextRecurringInstance } from '@/modules/accounting/services/practice/practiceTaskService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { sourceTaskId } = req.body as { sourceTaskId?: string };

  if (!sourceTaskId) {
    return apiResponse.badRequest(res, 'sourceTaskId is required');
  }

  try {
    const task = await generateNextRecurringInstance(companyId, req.user.id, sourceTaskId);
    return apiResponse.created(res, task);
  } catch (err) {
    log.error('Task recurring generate failed', { error: err, sourceTaskId }, 'practice-api');
    return apiResponse.badRequestFromError(res, err, 'Recurring instance generation failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
