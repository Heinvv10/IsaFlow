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
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { scanAllDueConnections } from '@/modules/accounting/services/capture/imapMirrorService';
import { runPopSweeps } from '@/modules/accounting/services/capture/pop/popSweeps';

/**
 * The whole request's budget: scripts/isaflow-mirror-scan.service gives curl --max-time 300. The POP sweeps
 * start nothing after it (popSweeps.ts), so the answer is sent before curl gives up.
 */
const REQUEST_BUDGET_MS = 270_000;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-mirror-scan');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
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
  // After the scan: POP bank-line matching and the SharePoint copy, within what is left. runPopSweeps never throws.
  const pop = await runPopSweeps({ deadline: started + REQUEST_BUDGET_MS });
  const durationMs = Date.now() - started;

  log.info('Cron complete: mirror-scan', {
    connections: results.length,
    ...summary,
    pop,
    durationMs,
  }, 'cron-mirror-scan');

  return apiResponse.success(res, {
    connections: results.length,
    ...summary,
    pop,
    durationMs,
    results,
  });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
