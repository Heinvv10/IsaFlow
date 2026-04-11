/**
 * Job Queue Service — Background job management
 * Provides enqueue, claim (FOR UPDATE SKIP LOCKED), and lifecycle methods.
 * All DB writes are atomic — safe for concurrent workers.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BackgroundJob {
  id: string;
  company_id: string | null;
  job_type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  scheduled_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  created_at: string | Date;
}

export interface EnqueueOptions {
  companyId?: string;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
}

export interface ListJobsResult {
  jobs: BackgroundJob[];
  total: number;
}

export interface ListJobsFilters {
  status?: string;
  jobType?: string;
  limit?: number;
  offset?: number;
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

export async function enqueueJob(
  jobType: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {}
): Promise<string> {
  const {
    companyId = null,
    priority = 5,
    scheduledAt = new Date(),
    maxAttempts = 3,
  } = options;

  try {
    const rows = await sql`
      INSERT INTO background_jobs (
        company_id, job_type, payload, priority, scheduled_at, max_attempts
      ) VALUES (
        ${companyId}::UUID,
        ${jobType},
        ${JSON.stringify(payload)}::JSONB,
        ${priority},
        ${scheduledAt.toISOString()}::TIMESTAMPTZ,
        ${maxAttempts}
      )
      RETURNING id
    ` as Array<{ id: string }>;

    const id = rows[0]!.id;
    log.info('Job enqueued', { jobType, companyId, id, priority }, 'job-queue-service');
    return id;
  } catch (err) {
    log.error('enqueueJob failed', { jobType, error: err }, 'job-queue-service');
    throw err;
  }
}

// ─── Claim next job atomically ─────────────────────────────────────────────────

export async function getNextJob(jobTypes?: string[]): Promise<BackgroundJob | null> {
  try {
    let rows: BackgroundJob[];

    if (jobTypes && jobTypes.length > 0) {
      rows = await sql`
        UPDATE background_jobs
        SET status = 'running', started_at = NOW(), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM background_jobs
          WHERE status = 'pending'
            AND scheduled_at <= NOW()
            AND job_type = ANY(${jobTypes})
          ORDER BY priority ASC, scheduled_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      ` as BackgroundJob[];
    } else {
      rows = await sql`
        UPDATE background_jobs
        SET status = 'running', started_at = NOW(), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM background_jobs
          WHERE status = 'pending'
            AND scheduled_at <= NOW()
          ORDER BY priority ASC, scheduled_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      ` as BackgroundJob[];
    }

    return rows[0] ?? null;
  } catch (err) {
    log.error('getNextJob failed', { jobTypes, error: err }, 'job-queue-service');
    throw err;
  }
}

// ─── Mark complete ─────────────────────────────────────────────────────────────

export async function markJobComplete(
  jobId: string,
  result?: Record<string, unknown>
): Promise<void> {
  try {
    await sql`
      UPDATE background_jobs
      SET status = 'completed',
          completed_at = NOW(),
          result = ${result ? JSON.stringify(result) : null}::JSONB
      WHERE id = ${jobId}::UUID
    `;
    log.info('Job completed', { jobId }, 'job-queue-service');
  } catch (err) {
    log.error('markJobComplete failed', { jobId, error: err }, 'job-queue-service');
    throw err;
  }
}

// ─── Mark failed ──────────────────────────────────────────────────────────────

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  try {
    await sql`
      UPDATE background_jobs
      SET status = CASE
            WHEN attempts >= max_attempts THEN 'failed'
            ELSE 'pending'
          END,
          error_message = ${error},
          started_at = NULL
      WHERE id = ${jobId}::UUID
    `;
    log.warn('Job failed', { jobId, error }, 'job-queue-service');
  } catch (err) {
    log.error('markJobFailed failed', { jobId, error: err }, 'job-queue-service');
    throw err;
  }
}

// ─── Retry a failed job ───────────────────────────────────────────────────────

export async function retryJob(jobId: string): Promise<void> {
  try {
    await sql`
      UPDATE background_jobs
      SET status = 'pending',
          error_message = NULL,
          started_at = NULL,
          scheduled_at = NOW()
      WHERE id = ${jobId}::UUID AND status = 'failed'
    `;
    log.info('Job retried', { jobId }, 'job-queue-service');
  } catch (err) {
    log.error('retryJob failed', { jobId, error: err }, 'job-queue-service');
    throw err;
  }
}

// ─── List jobs ────────────────────────────────────────────────────────────────

export async function listJobs(
  companyId?: string | null,
  filters: ListJobsFilters = {}
): Promise<ListJobsResult> {
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  try {
    let jobs: BackgroundJob[];
    let countRows: Array<{ count: string }>;

    // Build queries based on filter combinations
    // Neon sql tagged templates don't support dynamic WHERE clause injection,
    // so we enumerate combinations.
    const hasCompany = companyId != null;
    const hasStatus = filters.status && filters.status !== 'all';
    const hasType = Boolean(filters.jobType);

    if (hasCompany && hasStatus && hasType) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE company_id = ${companyId!}::UUID AND status = ${filters.status!} AND job_type = ${filters.jobType!}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs
        WHERE company_id = ${companyId!}::UUID AND status = ${filters.status!} AND job_type = ${filters.jobType!}
      ` as Array<{ count: string }>;
    } else if (hasCompany && hasStatus) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE company_id = ${companyId!}::UUID AND status = ${filters.status!}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs
        WHERE company_id = ${companyId!}::UUID AND status = ${filters.status!}
      ` as Array<{ count: string }>;
    } else if (hasCompany && hasType) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE company_id = ${companyId!}::UUID AND job_type = ${filters.jobType!}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs
        WHERE company_id = ${companyId!}::UUID AND job_type = ${filters.jobType!}
      ` as Array<{ count: string }>;
    } else if (hasCompany) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE company_id = ${companyId!}::UUID
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs WHERE company_id = ${companyId!}::UUID
      ` as Array<{ count: string }>;
    } else if (hasStatus && hasType) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE status = ${filters.status!} AND job_type = ${filters.jobType!}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs
        WHERE status = ${filters.status!} AND job_type = ${filters.jobType!}
      ` as Array<{ count: string }>;
    } else if (hasStatus) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE status = ${filters.status!}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs WHERE status = ${filters.status!}
      ` as Array<{ count: string }>;
    } else if (hasType) {
      jobs = await sql`
        SELECT * FROM background_jobs
        WHERE job_type = ${filters.jobType!}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`
        SELECT COUNT(*)::TEXT as count FROM background_jobs WHERE job_type = ${filters.jobType!}
      ` as Array<{ count: string }>;
    } else {
      jobs = await sql`
        SELECT * FROM background_jobs
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as BackgroundJob[];
      countRows = await sql`SELECT COUNT(*)::TEXT as count FROM background_jobs` as Array<{ count: string }>;
    }

    return { jobs, total: parseInt(countRows[0]?.count ?? '0', 10) };
  } catch (err) {
    log.error('listJobs failed', { companyId, error: err }, 'job-queue-service');
    throw err;
  }
}
