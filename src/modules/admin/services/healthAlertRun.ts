/**
 * One scheduled health-alert pass (admin audit OP-1): take the same snapshot
 * GET /api/admin/health takes, then hand it to the same checkAndAlert, so the
 * alerts no longer depend on an admin having /admin/health open.
 *
 * Roles match the route. The snapshot reads every tenant's rows, so it runs in
 * a read-only transaction on the platform_admin pool (BYPASSRLS) under an ALS
 * context pointing at that client, as withPlatformAdmin runs the handler.
 * checkAndAlert runs after that transaction, outside any ALS context, on the
 * app pool: exactly where the route's runAfterCommit starts it. Debounce and
 * cooldown are claimed under an advisory lock before any send
 * (healthAlertState.ts), so a scheduled pass and an open page never both alert
 * on the same change.
 *
 * Unlike the route, a failure is thrown, not swallowed: the caller
 * (POST /api/cron/health-alerts, every 5 minutes from
 * scripts/isaflow-health-alerts.timer) answers 500, so curl --fail and systemd
 * record the failed run. A snapshot that fails sends nothing. A successful pass
 * records `health_alerts_last_scheduled_run`, which the Health page shows, so a
 * timer that stopped (or was never installed) is visible there.
 */

import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { runOwnedContext } from '@/lib/afterCommit';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { checkAndAlert } from './healthAlertService';
import { recordScheduledRun } from './healthAlertState';
import { buildSystemHealth, type SystemHealthResponse } from './systemHealthService';

/** Stands in for the admin user id the route's context carries; nothing here writes an audit row. */
const SCHEDULED_ACTOR = 'system:health-alert-timer';

export async function runScheduledHealthAlert(): Promise<SystemHealthResponse['overall_status']> {
  const client = await getPlatformAdminPool().connect();
  let unusable = false;
  let health: SystemHealthResponse;
  try {
    await client.query('BEGIN READ ONLY');
    health = await runOwnedContext({ client, userId: SCHEDULED_ACTOR, claims: {} }, buildSystemHealth);
    await client.query('COMMIT');
  } catch (err) {
    unusable = await rollbackFailed(client, 'scheduled health alert');
    throw err;
  } finally {
    client.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
  }
  await checkAndAlert(health);
  // Only a pass that got this far counts: the Health page reads it to say whether the timer runs.
  await recordScheduledRun();
  return health.overall_status;
}
