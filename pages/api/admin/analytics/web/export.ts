/**
 * Admin Web Analytics CSV Export
 * GET /api/admin/analytics/web/export?website_id=&range=&include_bots=1
 * Raw events for one website and range. Bot sessions are left out unless
 * include_bots=1, as on the page; more than ADMIN_EXPORT_MAX_ROWS events is a 400.
 * One audited CSV (adminCsvExport): the cells
 * carry visitor-supplied text (page titles, UTM tags), so neutralising formula
 * cells matters here most.
 */
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PlatformAdminRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { ADMIN_EXPORT_MAX_ROWS, csvRow, sendAuditedCsv } from '@/modules/admin/services/adminCsvExport';

const RANGES: Record<string, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = req.query.website_id;
  const range = typeof req.query.range === 'string' ? req.query.range : '7d';
  const includeBots = req.query.include_bots === '1';
  if (!isUuidParam(websiteId) || !RANGES[range]) return apiResponse.badRequest(res, 'website_id (a UUID) and a valid range required');

  // Counted first: above the cap the export is refused, not cut off at the oldest rows.
  const [counted] = await sql`
    SELECT COUNT(*)::int AS total
    FROM analytics_events e
    JOIN analytics_sessions s ON s.id = e.session_id
    WHERE e.website_id = ${websiteId}
      AND e.created_at >= NOW() - (${RANGES[range]})::interval
      AND (${includeBots}::boolean OR s.is_bot = false)
  `;
  const total = Number(counted?.total ?? 0);
  if (total > ADMIN_EXPORT_MAX_ROWS) {
    return apiResponse.badRequest(res,
      `${total.toLocaleString('en-ZA')} events match; choose a shorter range to export at most ${ADMIN_EXPORT_MAX_ROWS.toLocaleString('en-ZA')}`);
  }

  const rows = await sql`
    SELECT e.created_at, e.event_type, e.event_name, e.url_path, e.page_title,
           e.referrer_domain, e.referrer_path, e.url_query,
           s.visitor_hash, s.utm_source, s.utm_medium, s.utm_campaign,
           s.country, s.device, s.browser, s.os, s.lang, s.is_bot
    FROM analytics_events e
    JOIN analytics_sessions s ON s.id = e.session_id
    WHERE e.website_id = ${websiteId}
      AND e.created_at >= NOW() - (${RANGES[range]})::interval
      AND (${includeBots}::boolean OR s.is_bot = false)
    ORDER BY e.created_at ASC, e.id
  `;

  const header = [
    'created_at','event_type','event_name','url_path','page_title',
    'referrer_domain','referrer_path','url_query',
    'visitor_hash','utm_source','utm_medium','utm_campaign',
    'country','device','browser','os','lang','is_bot',
  ];
  const lines = (rows as DbRow[]).map((r) => csvRow(header.map((k) => r[k])));

  await sendAuditedCsv(req, res, {
    export: 'web_analytics',
    filename: `analytics-${websiteId.slice(0, 8)}-${range}-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: { website_id: websiteId, range, include_bots: includeBots },
    header,
    lines,
  });
}

export default withAdmin(handler);
