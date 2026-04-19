/**
 * Practice Task by ID API
 * GET    — get single task
 * PUT    — update task
 * DELETE — delete task
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getTask,
  updateTask,
  deleteTask,
} from '@/modules/accounting/services/practice/practiceTaskService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (req.method === 'GET') {
    const task = await getTask(companyId, id);
    if (!task) return apiResponse.notFound(res, 'Task not found');
    return apiResponse.success(res, task);
  }

  if (req.method === 'PUT') {
    try {
      const task = await updateTask(companyId, id, req.body);
      return apiResponse.success(res, task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      log.error('Task update failed', { error: err, id }, 'practice-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteTask(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      log.error('Task delete failed', { error: err, id }, 'practice-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
