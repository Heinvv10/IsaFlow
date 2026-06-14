/**
 * Practice Tasks API
 * GET  — list tasks (filters: jobId, assignedTo, status, overdueOnly, parentTaskId)
 * POST — create task
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listTasks,
  createTask,
  type PracticeTask,
} from '@/modules/accounting/services/practice/practiceTaskService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { jobId, assignedTo, status, overdueOnly, parentTaskId } = req.query;
    const result = await listTasks(companyId, {
      jobId: jobId as string | undefined,
      assignedTo: assignedTo as string | undefined,
      status: status as PracticeTask['status'] | undefined,
      overdueOnly: overdueOnly === 'true',
      parentTaskId: parentTaskId as string | undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    try {
      const task = await createTask(companyId, req.user.id, req.body);
      return apiResponse.created(res, task);
    } catch (err) {
      log.error('Task create failed', { error: err }, 'practice-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
