/**
 * Practice Task Transition API
 * POST — transition task to a new status
 *        body: { id: string, newStatus: PracticeTask['status'] }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { transitionTask } from '@/modules/accounting/services/practice/practiceTaskService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { id, newStatus } = req.body as { id?: string; newStatus?: string };

  if (!id || !newStatus) {
    return apiResponse.badRequest(res, 'id and newStatus are required');
  }

  try {
    const task = await transitionTask(companyId, id, newStatus as Parameters<typeof transitionTask>[2]);
    return apiResponse.success(res, task);
  } catch (err) {
    log.error('Task transition failed', { error: err, id, newStatus }, 'practice-api');
    return apiResponse.badRequestFromError(res, err, 'Transition failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
