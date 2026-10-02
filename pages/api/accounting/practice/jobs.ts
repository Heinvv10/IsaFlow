/**
 * Practice Jobs API
 * GET  — list jobs (filters: practiceClientId, partnerId, preparerId, status, dueBefore)
 * POST — create job
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { isJsonObjectBody } from '@/lib/validation';
import { JobBudgetInvalidError } from '@/modules/accounting/services/practice/practiceJobBudget';
import {
  listJobs,
  createJob,
  type PracticeJob,
  type PracticeJobInput,
} from '@/modules/accounting/services/practice/practiceJobService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { practiceClientId, partnerId, preparerId, status, dueBefore } = req.query;
    const result = await listJobs(companyId, {
      practiceClientId: practiceClientId as string | undefined,
      partnerId: partnerId as string | undefined,
      preparerId: preparerId as string | undefined,
      status: status as PracticeJob['status'] | undefined,
      dueBefore: dueBefore as string | undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const input = req.body as PracticeJobInput;
    if (!isJsonObjectBody(input)) return apiResponse.badRequest(res, 'Request body must be a JSON object');
    try {
      const job = await createJob(companyId, req.user.id, input);
      return apiResponse.created(res, job);
    } catch (err) {
      if (err instanceof JobBudgetInvalidError) {
        log.warn('Job create refused', { code: err.code }, 'practice-api');
        return apiResponse.badRequest(res, err.message);
      }
      log.error('Job create failed', { error: err }, 'practice-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
