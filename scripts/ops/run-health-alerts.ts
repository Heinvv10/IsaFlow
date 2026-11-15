/**
 * Scheduled admin health alerts (admin audit OP-1). Run by
 * scripts/ops/systemd/isaflow-health-alerts.{service,timer} every 5 minutes, so
 * an alert no longer waits for an admin to have /admin/health open.
 *
 * One pass: the same snapshot GET /api/admin/health takes (platform_admin pool),
 * then the same checkAndAlert, with its debounce and one-hour cooldown
 * (src/modules/admin/services/healthAlertRun.ts). Exit 0 when the pass ran
 * (alert sent, suppressed, or nothing to send), 1 when it failed.
 *
 * Env: DATABASE_URL, PLATFORM_ADMIN_DATABASE_URL and the SMTP settings, from
 * the app's env file (the unit's EnvironmentFile; bun also reads .env.local
 * from the working directory).
 *
 *   bun scripts/ops/run-health-alerts.ts
 */
import { log } from '@/lib/logger';
import { runScheduledHealthAlert } from '@/modules/admin/services/healthAlertRun';

export async function main(): Promise<number> {
  try {
    const status = await runScheduledHealthAlert();
    log.info('Scheduled health alert check done', { overall_status: status }, 'health-alert-timer');
    return 0;
  } catch (err) {
    log.error('Scheduled health alert check failed', {
      error: err instanceof Error ? err.message : String(err),
    }, 'health-alert-timer');
    return 1;
  }
}

if (import.meta.main) {
  // process.exit, not a natural end: the pg pools keep the event loop alive.
  void main().then((code) => process.exit(code));
}
