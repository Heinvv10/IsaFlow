/**
 * Admin Job Queue — Bulk Actions
 * POST /api/admin/job-queue/bulk-action
 *
 * Body: { action, ids?, olderThanDays? }
 *   action 'retry'      — failed → pending for given IDs
 *   action 'cancel'     — pending/running → cancelled for given IDs
 *   action 'delete_old' — delete completed/cancelled/failed older than N days
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { adminDistinctUuids } from '@/modules/admin/middleware/adminRequestErrors';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

// ─── Types ────────────────────────────────────────────────────────────────────

const PostBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('retry'),
    ids:    adminDistinctUuids(200),
  }).strict(),
  z.object({
    action: z.literal('cancel'),
    ids:    adminDistinctUuids(200),
  }).strict(),
  z.object({
    action:        z.literal('delete_old'),
    olderThanDays: z.number().int().min(1).max(365).optional(),
  }).strict(),
]);

interface BulkResult {
  processed: number;
  errors: string[];
}

/** A retry / cancel batch: the answer, plus the jobs it changed (each gets its own audit row). */
interface JobBatch extends BulkResult {
  changedIds: string[];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// "Not found / wrong status" is a per-item answer (RETURNING). A thrown error is not a per-item refusal: it aborts
// the batch (500, rolled back), never a 200 whose earlier items the poisoned transaction would not keep (#1405 L8).
async function retryBulk(ids: string[]): Promise<JobBatch> {
  const errors: string[] = [];
  const changedIds: string[] = [];

  for (const id of ids) {
    const rows = await sql`
      UPDATE background_jobs
      SET status = 'pending',
          error_message = NULL,
          started_at = NULL,
          scheduled_at = NOW()
      WHERE id = ${id}::UUID AND status = 'failed'
      RETURNING id
    ` as Array<{ id: string }>;

    if (rows.length > 0) {
      changedIds.push(id);
    } else {
      errors.push(`Job ${id}: not found or not in failed status`);
    }
  }

  return { processed: changedIds.length, errors, changedIds };
}

async function cancelBulk(ids: string[]): Promise<JobBatch> {
  const errors: string[] = [];
  const changedIds: string[] = [];

  for (const id of ids) {
    const rows = await sql`
      UPDATE background_jobs
      SET status = 'cancelled',
          completed_at = NOW()
      WHERE id = ${id}::UUID AND status IN ('pending', 'running')
      RETURNING id
    ` as Array<{ id: string }>;

    if (rows.length > 0) {
      changedIds.push(id);
    } else {
      errors.push(`Job ${id}: not found or not cancellable`);
    }
  }

  return { processed: changedIds.length, errors, changedIds };
}

async function deleteOldJobs(olderThanDays: number): Promise<BulkResult> {
  const cutoffDays = Math.max(1, Math.min(olderThanDays, 365));

  const rows = await sql`
    DELETE FROM background_jobs
    WHERE status IN ('completed', 'cancelled', 'failed')
      AND created_at < NOW() - (${cutoffDays} || ' days')::INTERVAL
    RETURNING id
  ` as Array<{ id: string }>;

  return { processed: rows.length, errors: [] };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const data = parsed.data;
  const { action } = data;

  if (action === 'retry') {
    const { changedIds, ...result } = await retryBulk(data.ids);
    // One row per job it changed, as the single retry writes (review #1405 round 7): each job's own view lists it.
    for (const id of changedIds) await logAdminAction(req.user.id, 'job.retry', 'background_job', id, { bulk: true }, getIp(req));
    log.info('Bulk retry', { processed: result.processed, errors: result.errors.length }, 'admin-job-bulk');
    return apiResponse.success(res, result, `Retried ${result.processed} job(s)`);
  }

  if (action === 'cancel') {
    const { changedIds, ...result } = await cancelBulk(data.ids);
    for (const id of changedIds) await logAdminAction(req.user.id, 'job.cancel', 'background_job', id, { bulk: true }, getIp(req));
    log.info('Bulk cancel', { processed: result.processed, errors: result.errors.length }, 'admin-job-bulk');
    return apiResponse.success(res, result, `Cancelled ${result.processed} job(s)`);
  }

  if (action === 'delete_old') {
    const days = data.olderThanDays ?? 30;
    const result = await deleteOldJobs(days);
    await logAdminAction(req.user.id, 'job.delete_old', 'background_job', null,
      { older_than_days: days, deleted: result.processed }, getIp(req));
    log.info('Bulk delete old jobs', { days, processed: result.processed }, 'admin-job-bulk');
    return apiResponse.success(res, result, `Deleted ${result.processed} old job(s)`);
  }

  return apiResponse.badRequest(res, `Unknown action: ${String(action)}`);
}

export default withAdmin(withCsrf(handler));
