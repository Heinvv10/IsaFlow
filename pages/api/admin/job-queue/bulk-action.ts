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
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// ─── Types ────────────────────────────────────────────────────────────────────

type BulkAction = 'retry' | 'cancel' | 'delete_old';

interface BulkActionBody {
  action: BulkAction;
  ids?: string[];
  olderThanDays?: number;
}

interface BulkResult {
  processed: number;
  errors: string[];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function retryBulk(ids: string[]): Promise<BulkResult> {
  const errors: string[] = [];
  let processed = 0;

  for (const id of ids) {
    try {
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
        processed++;
      } else {
        errors.push(`Job ${id}: not found or not in failed status`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Job ${id}: ${msg}`);
    }
  }

  return { processed, errors };
}

async function cancelBulk(ids: string[]): Promise<BulkResult> {
  const errors: string[] = [];
  let processed = 0;

  for (const id of ids) {
    try {
      const rows = await sql`
        UPDATE background_jobs
        SET status = 'cancelled',
            completed_at = NOW()
        WHERE id = ${id}::UUID AND status IN ('pending', 'running')
        RETURNING id
      ` as Array<{ id: string }>;

      if (rows.length > 0) {
        processed++;
      } else {
        errors.push(`Job ${id}: not found or not cancellable`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Job ${id}: ${msg}`);
    }
  }

  return { processed, errors };
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

  const { action, ids, olderThanDays } = req.body as BulkActionBody;

  if (!action) return apiResponse.badRequest(res, 'action is required');

  if (action === 'retry') {
    if (!ids || ids.length === 0) return apiResponse.badRequest(res, 'ids are required for retry');
    if (ids.length > 200) return apiResponse.badRequest(res, 'Maximum 200 IDs per bulk action');

    const result = await retryBulk(ids);
    log.info('Bulk retry', { processed: result.processed, errors: result.errors.length }, 'admin-job-bulk');
    return apiResponse.success(res, result, `Retried ${result.processed} job(s)`);
  }

  if (action === 'cancel') {
    if (!ids || ids.length === 0) return apiResponse.badRequest(res, 'ids are required for cancel');
    if (ids.length > 200) return apiResponse.badRequest(res, 'Maximum 200 IDs per bulk action');

    const result = await cancelBulk(ids);
    log.info('Bulk cancel', { processed: result.processed, errors: result.errors.length }, 'admin-job-bulk');
    return apiResponse.success(res, result, `Cancelled ${result.processed} job(s)`);
  }

  if (action === 'delete_old') {
    const days = olderThanDays ?? 30;
    if (typeof days !== 'number' || days < 1) {
      return apiResponse.badRequest(res, 'olderThanDays must be a positive number');
    }

    const result = await deleteOldJobs(days);
    log.info('Bulk delete old jobs', { days, processed: result.processed }, 'admin-job-bulk');
    return apiResponse.success(res, result, `Deleted ${result.processed} old job(s)`);
  }

  return apiResponse.badRequest(res, `Unknown action: ${String(action)}`);
}

export default withAdmin(handler);
