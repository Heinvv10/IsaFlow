/**
 * Practice Job by ID API
 * GET    — get single job
 * PUT    — update job
 * DELETE — delete job
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getJob,
  updateJob,
  deleteJob,
} from '@/modules/accounting/services/practice/practiceJobService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (req.method === 'GET') {
    const job = await getJob(companyId, id);
    if (!job) return apiResponse.notFound(res, 'Job not found');
    return apiResponse.success(res, job);
  }

  if (req.method === 'PUT') {
    try {
      const job = await updateJob(companyId, id, req.body);
      return apiResponse.success(res, job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      log.error('Job update failed', { error: err, id }, 'practice-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteJob(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      log.error('Job delete failed', { error: err, id }, 'practice-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
