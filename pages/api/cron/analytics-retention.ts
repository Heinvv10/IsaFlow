/**
 * Cron — analytics retention sweep. Deletes events/sessions older than 180 days.
 *
 * Cadence: nightly (02:30 SAST). Events are deleted first; sessions with no
 * remaining events are then pruned. Websites are never deleted (platform config).
 *
 * Auth: X-Cron-Secret header must match CRON_SECRET env var.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

const RETENTION_DAYS = 180;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-analytics-retention');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-analytics-retention');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();

  const eventsResult = await sql`
    WITH deleted AS (
      DELETE FROM analytics_events
      WHERE created_at < NOW() - (${`${RETENTION_DAYS} days`})::interval
      RETURNING id
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `;
  const eventsDeleted = ((eventsResult[0] as DbRow | undefined)?.n as number) ?? 0;

  const sessionsResult = await sql`
    WITH deleted AS (
      DELETE FROM analytics_sessions
      WHERE last_seen < NOW() - (${`${RETENTION_DAYS} days`})::interval
        AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.session_id = analytics_sessions.id)
      RETURNING id
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `;
  const sessionsDeleted = ((sessionsResult[0] as DbRow | undefined)?.n as number) ?? 0;

  const durationMs = Date.now() - started;
  log.info(
    'Cron complete: analytics-retention',
    { durationMs, eventsDeleted, sessionsDeleted, retentionDays: RETENTION_DAYS },
    'cron-analytics-retention',
  );
  return apiResponse.success(res, { durationMs, eventsDeleted, sessionsDeleted, retentionDays: RETENTION_DAYS });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
