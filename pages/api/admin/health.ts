/**
 * Admin System Health API
 * GET /api/admin/health — DB latency, job queue, email delivery, sessions, trials, recent errors
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

export interface DbHealth {
  status: 'ok' | 'error';
  latency_ms: number;
  size_mb: number;
  error?: string;
}

export interface JobQueueHealth {
  pending: number;
  running: number;
  failed: number;
  oldest_pending_age_minutes: number | null;
}

export interface EmailHealth {
  sent_24h: number;
  failed_24h: number;
  success_rate_percent: number;
}

export interface TrialHealth {
  expiring_in_7d: number;
}

export interface RecentError {
  id: string;
  action: string;
  target_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface SystemHealthResponse {
  db: DbHealth;
  job_queue: JobQueueHealth;
  email: EmailHealth;
  active_sessions_24h: number;
  trials: TrialHealth;
  recent_errors: RecentError[];
  overall_status: 'healthy' | 'degraded' | 'critical';
  checked_at: string;
}

// ─── DB Health ────────────────────────────────────────────────────────────────

async function getDbHealth(): Promise<DbHealth> {
  const start = Date.now();
  try {
    const rows = await sql`
      SELECT ROUND(pg_database_size(current_database()) / 1048576.0, 2) AS size_mb
    `;
    const latency_ms = Date.now() - start;
    const size_mb = parseFloat((rows[0] as Row).size_mb as string) || 0;
    return { status: 'ok', latency_ms, size_mb };
  } catch (err) {
    return {
      status: 'error',
      latency_ms: Date.now() - start,
      size_mb: 0,
      error: err instanceof Error ? err.message : 'Unknown DB error',
    };
  }
}

// ─── Job Queue Health ─────────────────────────────────────────────────────────

async function getJobQueueHealth(): Promise<JobQueueHealth> {
  try {
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
        COUNT(*) FILTER (WHERE status = 'running')  AS running,
        COUNT(*) FILTER (WHERE status = 'failed')   AS failed,
        EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending'))) / 60
          AS oldest_pending_age_minutes
      FROM background_jobs
    `;
    const row = rows[0] as Row;
    return {
      pending: parseInt(row.pending as string, 10) || 0,
      running: parseInt(row.running as string, 10) || 0,
      failed:  parseInt(row.failed  as string, 10) || 0,
      oldest_pending_age_minutes: row.oldest_pending_age_minutes != null
        ? Math.round(parseFloat(row.oldest_pending_age_minutes as string))
        : null,
    };
  } catch {
    return { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null };
  }
}

// ─── Email Health ─────────────────────────────────────────────────────────────

async function getEmailHealth(): Promise<EmailHealth> {
  try {
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')   AS sent_24h,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_24h
      FROM email_log
      WHERE sent_at >= NOW() - INTERVAL '24 hours'
    `;
    const row = rows[0] as Row;
    const sent   = parseInt(row.sent_24h   as string, 10) || 0;
    const failed = parseInt(row.failed_24h as string, 10) || 0;
    const total  = sent + failed;
    return {
      sent_24h:   sent,
      failed_24h: failed,
      success_rate_percent: total > 0 ? Math.round((sent / total) * 1000) / 10 : 100,
    };
  } catch {
    return { sent_24h: 0, failed_24h: 0, success_rate_percent: 100 };
  }
}

// ─── Active Sessions ──────────────────────────────────────────────────────────

async function getActiveSessions(): Promise<number> {
  try {
    const rows = await sql`
      SELECT COUNT(*) AS cnt
      FROM user_sessions
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND expires_at > NOW()
    `;
    return parseInt((rows[0] as Row).cnt as string, 10) || 0;
  } catch {
    return 0;
  }
}

// ─── Trials Expiring ──────────────────────────────────────────────────────────

async function getTrialHealth(): Promise<TrialHealth> {
  try {
    const rows = await sql`
      SELECT COUNT(*) AS cnt
      FROM companies
      WHERE status = 'trial'
        AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
    `;
    return { expiring_in_7d: parseInt((rows[0] as Row).cnt as string, 10) || 0 };
  } catch {
    return { expiring_in_7d: 0 };
  }
}

// ─── Recent Errors ────────────────────────────────────────────────────────────

async function getRecentErrors(): Promise<RecentError[]> {
  try {
    const rows = await sql`
      SELECT
        id::text AS id,
        action,
        target_type,
        COALESCE(details, '{}') AS details,
        created_at
      FROM admin_audit_log
      WHERE action ILIKE 'error%'
         OR action ILIKE '%fail%'
         OR action ILIKE '%denied%'
      ORDER BY created_at DESC
      LIMIT 10
    `;
    return (rows as Row[]).map((r) => {
      const raw = r.created_at;
      const created_at = raw instanceof Date ? raw.toISOString() : String(raw ?? '');
      return {
        id:          String(r.id ?? ''),
        action:      String(r.action ?? ''),
        target_type: String(r.target_type ?? ''),
        details:     (r.details as Record<string, unknown>) ?? {},
        created_at,
      };
    });
  } catch {
    return [];
  }
}

// ─── Overall Status ───────────────────────────────────────────────────────────

function deriveOverallStatus(
  db: DbHealth,
  jobs: JobQueueHealth,
  email: EmailHealth,
): SystemHealthResponse['overall_status'] {
  if (db.status === 'error') return 'critical';
  if (jobs.failed > 50 || email.success_rate_percent < 80) return 'degraded';
  if (db.latency_ms > 2000 || jobs.failed > 10 || email.success_rate_percent < 95) return 'degraded';
  return 'healthy';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  try {
    const [db, job_queue, email, active_sessions_24h, trials, recent_errors] = await Promise.all([
      getDbHealth(),
      getJobQueueHealth(),
      getEmailHealth(),
      getActiveSessions(),
      getTrialHealth(),
      getRecentErrors(),
    ]);

    const overall_status = deriveOverallStatus(db, job_queue, email);

    const payload: SystemHealthResponse = {
      db,
      job_queue,
      email,
      active_sessions_24h,
      trials,
      recent_errors,
      overall_status,
      checked_at: new Date().toISOString(),
    };

    log.info('System health check', { overall_status, db_latency: db.latency_ms }, 'admin-health-api');
    return apiResponse.success(res, payload);
  } catch (err) {
    log.error('System health check failed', { error: err }, 'admin-health-api');
    return apiResponse.internalError(res, err);
  }
}

export default withAdmin(handler);
