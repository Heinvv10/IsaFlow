/**
 * Cron endpoint — AR materialised-view refresh.
 *
 * Refreshes customer_invoice_view_summary (PRD-06 Phase 2) concurrently so
 * the AR list "last viewed" column reflects yesterday's traffic without a
 * per-row aggregate. Intended cadence: nightly.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * NOTE: REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index on
 * the MV (mig 427 provides idx_cust_inv_view_summary) and cannot run inside
 * a transaction block — Neon's single-shot `sql` helper issues each tagged
 * template as its own statement, which is what we want here.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
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

  await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY customer_invoice_view_summary`;
  const durationMs = Date.now() - started;

  log.info('Cron complete: ar-matview-refresh', { durationMs }, 'cron-ar-matview-refresh');
  return apiResponse.success(res, { refreshed: 'customer_invoice_view_summary', durationMs });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
