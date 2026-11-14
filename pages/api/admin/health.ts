/**
 * Admin System Health API
 * GET /api/admin/health — DB latency, job queue, email accepted by SMTP, sign-ins, trials, recent errors
 *
 * A metric that cannot be read is an error (500, logged), never a zero or a
 * "healthy": only the database probe itself degrades to status 'error'.
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { checkAndAlert } from '@/modules/admin/services/healthAlertService';
import { runAfterCommit } from '@/lib/afterCommit';
import { percentOrNull } from '@/modules/admin/services/metrics/revenueMath';

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
  /** Accepted by the SMTP server: not proof of delivery. */
  sent_24h: number;
  failed_24h: number;
  bounced_24h: number;
  /** sent / (sent + failed + bounced); null when no email was attempted. */
  success_rate_percent: number | null;
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
  /** Users whose last sign-in (users.last_login) was in the last 24 hours. */
  users_signed_in_24h: number;
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
    // The driver's text (host, port, SQL) goes to the log, never to the browser.
    log.error('Database health check failed', { message: err instanceof Error ? err.message : String(err) }, 'admin-health-api');
    return {
      status: 'error',
      latency_ms: Date.now() - start,
      size_mb: 0,
      error: 'database check failed',
    };
  }
}

// ─── Scalar Health Metrics (single round-trip) ───────────────────────────────

interface ScalarHealthMetrics {
  job_queue: JobQueueHealth;
  email: EmailHealth;
  users_signed_in_24h: number;
  trials: TrialHealth;
}

async function getScalarHealthMetrics(): Promise<ScalarHealthMetrics> {
  try {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*) FILTER (WHERE status = 'pending') FROM background_jobs)::int  AS pending,
        (SELECT COUNT(*) FILTER (WHERE status = 'running') FROM background_jobs)::int  AS running,
        (SELECT COUNT(*) FILTER (WHERE status = 'failed')  FROM background_jobs)::int  AS failed,
        (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending'))) / 60
         FROM background_jobs)                                                          AS oldest_pending_age_minutes,
        (SELECT COUNT(*) FILTER (WHERE status = 'sent')
         FROM email_log WHERE sent_at >= NOW() - INTERVAL '24 hours')::int             AS sent_24h,
        (SELECT COUNT(*) FILTER (WHERE status = 'failed')
         FROM email_log WHERE sent_at >= NOW() - INTERVAL '24 hours')::int             AS failed_24h,
        (SELECT COUNT(*) FILTER (WHERE status = 'bounced')
         FROM email_log WHERE sent_at >= NOW() - INTERVAL '24 hours')::int             AS bounced_24h,
        (SELECT COUNT(*)::int FROM users
         WHERE last_login >= NOW() - INTERVAL '24 hours')                               AS users_signed_in_24h,
        (SELECT COUNT(*)::int FROM companies
         WHERE status = 'trial'
           AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '7 days')              AS expiring_in_7d
    `;
    const r = rows[0] as Row;
    const sent    = parseInt(r.sent_24h    as string, 10) || 0;
    const failed  = parseInt(r.failed_24h  as string, 10) || 0;
    const bounced = parseInt(r.bounced_24h as string, 10) || 0;
    return {
      job_queue: {
        pending: parseInt(r.pending as string, 10) || 0,
        running: parseInt(r.running as string, 10) || 0,
        failed:  parseInt(r.failed  as string, 10) || 0,
        oldest_pending_age_minutes: r.oldest_pending_age_minutes != null
          ? Math.round(parseFloat(r.oldest_pending_age_minutes as string))
          : null,
      },
      email: {
        sent_24h:    sent,
        failed_24h:  failed,
        bounced_24h: bounced,
        success_rate_percent: percentOrNull(sent, sent + failed + bounced, 1),
      },
      users_signed_in_24h: parseInt(r.users_signed_in_24h as string, 10) || 0,
      trials: {
        expiring_in_7d: parseInt(r.expiring_in_7d as string, 10) || 0,
      },
    };
  } catch (err) {
    // Zeros here once read as "All systems operational" (admin audit 2.8).
    log.error('Health metrics could not be read', { error: err }, 'admin-health-api');
    throw err;
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
  } catch (err) {
    log.error('Recent error events could not be read', { error: err }, 'admin-health-api');
    throw err;
  }
}

// ─── Overall Status ───────────────────────────────────────────────────────────

function deriveOverallStatus(
  db: DbHealth,
  jobs: JobQueueHealth,
  email: EmailHealth,
): SystemHealthResponse['overall_status'] {
  if (db.status === 'error') return 'critical';
  const rate = email.success_rate_percent ?? 100; // nothing attempted: nothing failed
  if (jobs.failed > 50 || rate < 80) return 'degraded';
  if (db.latency_ms > 2000 || jobs.failed > 10 || rate < 95) return 'degraded';
  return 'healthy';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  try {
    const [db, scalars, recent_errors] = await Promise.all([
      getDbHealth(),
      getScalarHealthMetrics(),
      getRecentErrors(),
    ]);

    const { job_queue, email, users_signed_in_24h, trials } = scalars;
    const overall_status = deriveOverallStatus(db, job_queue, email);

    const payload: SystemHealthResponse = {
      db,
      job_queue,
      email,
      users_signed_in_24h,
      trials,
      recent_errors,
      overall_status,
      checked_at: new Date().toISOString(),
    };

    log.info('System health check', { overall_status, db_latency: db.latency_ms }, 'admin-health-api');

    // Never fail the health response because alerting failed. Starts after the
    // admin transaction COMMITs, on its own connection (R-075).
    runAfterCommit('health alert check', () => checkAndAlert(payload).catch((err: unknown) =>
      log.error('Health alert check failed', { error: err }, 'admin-health-api'),
    ));

    return apiResponse.success(res, payload);
  } catch (err) {
    log.error('System health check failed', { error: err }, 'admin-health-api');
    return apiResponse.internalError(res, err);
  }
}

export default withAdmin(handler);
