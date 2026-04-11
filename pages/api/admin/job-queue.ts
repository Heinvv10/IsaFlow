/**
 * Admin Job Queue API
 * GET  /api/admin/job-queue  — list jobs with optional filters
 * POST /api/admin/job-queue  { action: 'retry', jobId } — retry a failed job
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listJobs, retryJob } from '@/modules/accounting/services/jobQueueService';

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
    const { action, jobId } = req.body as { action?: string; jobId?: string };

    if (!action) return apiResponse.badRequest(res, 'action is required');
    if (!jobId) return apiResponse.badRequest(res, 'jobId is required');

    if (action === 'retry') {
      await retryJob(jobId);
      log.info('Job retried via admin API', { jobId }, 'admin-job-queue-api');
      return apiResponse.success(res, { jobId }, 'Job queued for retry');
    }

    return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(handler);
