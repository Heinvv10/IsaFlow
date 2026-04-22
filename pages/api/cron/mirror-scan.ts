/**
 * Cron endpoint — mirror-inbox scan.
 *
 * Walks every active imap_mirror_connections whose last_scan_at is older
 * than its scan_interval_minutes, pulls new messages through the capture
 * pipeline, and updates the UID cursor. Intended to be hit every 1-5
 * minutes by systemd timer or Cloudflare cron trigger.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { scanAllDueConnections } from '@/modules/accounting/services/capture/imapMirrorService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-mirror-scan');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-mirror-scan');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  log.info('Cron triggered: mirror-scan', {}, 'cron-mirror-scan');

  const results = await scanAllDueConnections();
  const summary = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      ingested: acc.ingested + r.ingested,
      skipped: acc.skipped + r.skipped,
      errors: acc.errors + r.errors,
    }),
    { scanned: 0, ingested: 0, skipped: 0, errors: 0 },
  );
  const durationMs = Date.now() - started;

  log.info('Cron complete: mirror-scan', {
    connections: results.length,
    ...summary,
    durationMs,
  }, 'cron-mirror-scan');

  return apiResponse.success(res, {
    connections: results.length,
    ...summary,
    durationMs,
    results,
  });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
