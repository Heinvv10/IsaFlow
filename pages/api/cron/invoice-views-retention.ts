/**
 * Cron — invoice view receipt retention (POPIA). Deletes customer_invoice_views rows older than 12 months: the viewer's
 * IP address and browser are kept to screen for fraud, not for ever.
 *
 * Cadence: daily (scripts/isaflow-invoice-views-retention.timer). Auth: X-Cron-Secret header must match CRON_SECRET.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { INVOICE_VIEW_RETENTION_MONTHS, purgeInvoiceViewReceipts } from '@/modules/accounting/services/ar/invoiceViewRetention';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-invoice-views-retention');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-invoice-views-retention');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  const deleted = await purgeInvoiceViewReceipts();
  const durationMs = Date.now() - started;
  log.info('Cron complete: invoice-views-retention', { deleted, retentionMonths: INVOICE_VIEW_RETENTION_MONTHS, durationMs }, 'cron-invoice-views-retention');
  return apiResponse.success(res, { deleted, retentionMonths: INVOICE_VIEW_RETENTION_MONTHS, durationMs });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
