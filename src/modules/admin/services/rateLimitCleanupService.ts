/**
 * Rate-limit cleanup service (M14 / WS-2b).
 *
 * Prunes stale rows from rate_limit_counters and account_lockouts so the
 * tables don't grow unboundedly. Intended to be called nightly from the
 * /api/cron/rate-limit-cleanup route.
 *
 * Safety rules:
 *  - rate_limit_counters: delete rows whose window_start is older than 1 day
 *    (longer than the maximum window used by any rate limiter).
 *  - account_lockouts: delete rows that are expired (locked_until < NOW() or
 *    NULL) AND whose last_failed_at is older than 1 day. Active lockouts
 *    (locked_until >= NOW()) are never deleted.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface RateLimitCleanupResult {
  countersDeleted: number;
  lockoutsDeleted: number;
}

export async function cleanupRateLimitData(): Promise<RateLimitCleanupResult> {
  const countersResult = (await sql`
    WITH deleted AS (
      DELETE FROM rate_limit_counters
      WHERE window_start < NOW() - INTERVAL '1 day'
      RETURNING key
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `) as { n: number }[];

  const countersDeleted = countersResult[0]?.n ?? 0;

  const lockoutsResult = (await sql`
    WITH deleted AS (
      DELETE FROM account_lockouts
      WHERE (locked_until IS NULL OR locked_until < NOW())
        AND last_failed_at < NOW() - INTERVAL '1 day'
      RETURNING email
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `) as { n: number }[];

  const lockoutsDeleted = lockoutsResult[0]?.n ?? 0;

  log.info(
    'Rate-limit cleanup complete',
    { countersDeleted, lockoutsDeleted },
    'rateLimitCleanup',
  );

  return { countersDeleted, lockoutsDeleted };
}
