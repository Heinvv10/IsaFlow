/**
 * Admin Job Queue API
 * GET  /api/admin/job-queue  — list jobs with optional filters
 * POST /api/admin/job-queue  { action: 'retry', jobId } — retry a failed job
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listJobs, retryJob } from '@/modules/accounting/services/core/jobQueueService';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  action: z.literal('retry'),
  jobId:  UUID,
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { status, job_type, company_id, limit, offset } = req.query;

    const result = await listJobs(
      (company_id as string | undefined) ?? null,
      {
        status: status as string | undefined,
        jobType: job_type as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      }
    );

    return apiResponse.success(res, result);
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    const { jobId } = parsed.data;
    await retryJob(jobId);
    log.info('Job retried via admin API', { jobId }, 'admin-job-queue-api');
    return apiResponse.success(res, { jobId }, 'Job queued for retry');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
