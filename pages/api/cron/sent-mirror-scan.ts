/**
 * Cron endpoint — sent-mirror scan.
 *
 * Walks every active sent_mirror_connections row whose last_scan_at is
 * older than its scan_interval_minutes. Hash-matches outbound attachments
 * to existing invoice snapshots; captures new outbound documents for the
 * ones without a match.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var
 * (same secret used by the inbound mirror + dunning cron).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { scanAllDueSentConnections } from '@/modules/accounting/services/ar/sentMirrorService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-sent-mirror-scan');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-sent-mirror-scan');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  log.info('Cron triggered: sent-mirror-scan', {}, 'cron-sent-mirror-scan');

  const results = await scanAllDueSentConnections();
  const summary = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      linked: acc.linked + r.linked,
      captured: acc.captured + r.captured,
      skipped: acc.skipped + r.skipped,
      errors: acc.errors + r.errors,
    }),
    { scanned: 0, linked: 0, captured: 0, skipped: 0, errors: 0 },
  );
  const durationMs = Date.now() - started;

  log.info('Cron complete: sent-mirror-scan', {
    connections: results.length,
    ...summary,
    durationMs,
  }, 'cron-sent-mirror-scan');

  return apiResponse.success(res, {
    connections: results.length,
    ...summary,
    durationMs,
    results,
  });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
