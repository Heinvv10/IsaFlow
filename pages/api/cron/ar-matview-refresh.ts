/**
 * Cron endpoint — AR materialised-view refresh.
 *
 * Refreshes customer_invoice_view_summary (PRD-06 Phase 2) concurrently so
 * the AR list "last viewed" column reflects yesterday's traffic without a
 * per-row aggregate. Intended cadence: nightly.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * NOTE: REFRESH MATERIALIZED VIEW CONCURRENTLY needs a unique index on the
 * MV (mig 427 provides idx_cust_inv_view_summary) and must be run by the
 * view's owner, so the cron calls a SECURITY DEFINER wrapper that refreshes
 * this one view and takes no input: since 930,
 * refresh_customer_invoice_view_summary_if_due(), which skips, and says so,
 * while another refresh runs or within 10 minutes of the last. Only
 * migration_admin may call it: a caller can hold its lock to the end of its
 * own transaction.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { timingSafeEqualStr } from '@/lib/timingSafe';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-ar-matview-refresh');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-ar-matview-refresh');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  log.info('Cron triggered: ar-matview-refresh', {}, 'cron-ar-matview-refresh');

  // false: another refresh is running, or one finished under 10 minutes ago
  // (migration 930), so a loop of calls cannot keep the view refreshing.
  // On the migration_admin pool, the only role that may call it (930).
  const { rows } = await migrationAdminPool().query<{ refreshed: boolean }>(
    'SELECT public.refresh_customer_invoice_view_summary_if_due() AS refreshed',
  );
  const refreshed = rows[0]?.refreshed === true;
  const durationMs = Date.now() - started;

  log.info('Cron complete: ar-matview-refresh', { refreshed, durationMs }, 'cron-ar-matview-refresh');
  return apiResponse.success(res, { view: 'customer_invoice_view_summary', refreshed, durationMs });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
