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
import { checkAndAlert } from '@/modules/admin/services/healthAlertService';
import { buildSystemHealth } from '@/modules/admin/services/systemHealthService';
import { runAfterCommit } from '@/lib/afterCommit';

export type {
  DbHealth, JobQueueHealth, EmailHealth, TrialHealth, RecentError, SystemHealthResponse,
} from '@/modules/admin/services/systemHealthService';

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  try {
    const payload = await buildSystemHealth();

    log.info('System health check', { overall_status: payload.overall_status, db_latency: payload.db.latency_ms }, 'admin-health-api');

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
