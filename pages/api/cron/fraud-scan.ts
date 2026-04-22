/**
 * Cron endpoint — nightly fraud scan across every company.
 *
 * Walks companies with at least one supplier linked to a shared template
 * and (re-)scans them via supplierGraphService.scanCompanyForFraud. Cheap
 * per-company and idempotent — safe to run every 24h.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { scanCompanyForFraud } from '@/modules/accounting/services/capture/supplierGraphService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  if (!process.env.CRON_SECRET) {
    return apiResponse.internalError(res, new Error('CRON_SECRET not configured'));
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-fraud-scan');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  log.info('Cron triggered: fraud-scan', {}, 'cron-fraud-scan');

  const companies = (await sql`
    SELECT DISTINCT s.company_id
    FROM suppliers s
    WHERE s.platform_template_id IS NOT NULL
      AND s.is_active = true
  `) as Array<{ company_id: string }>;

  let totalCreated = 0;
  let totalRefreshed = 0;
  for (const row of companies) {
    try {
      const r = await scanCompanyForFraud(row.company_id);
      totalCreated += r.created;
      totalRefreshed += r.refreshed;
    } catch (err) {
      log.warn('fraud scan failed for company', { companyId: row.company_id, err }, 'cron-fraud-scan');
    }
  }

  const durationMs = Date.now() - started;
  log.info('Cron complete: fraud-scan', {
    companies: companies.length, totalCreated, totalRefreshed, durationMs,
  }, 'cron-fraud-scan');

  return apiResponse.success(res, {
    companies: companies.length,
    created: totalCreated,
    refreshed: totalRefreshed,
    durationMs,
  });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
