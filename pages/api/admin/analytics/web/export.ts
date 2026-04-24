import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PlatformAdminRequest } from '@/lib/auth';

const RANGES: Record<string, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = (req.query.website_id as string) || '';
  const range = (req.query.range as string) || '7d';
  if (!websiteId || !RANGES[range]) return apiResponse.badRequest(res, 'website_id and valid range required');

  const rows = await sql`
    SELECT e.created_at, e.event_type, e.event_name, e.url_path, e.page_title,
           e.referrer_domain, e.referrer_path, e.url_query,
           s.visitor_hash, s.utm_source, s.utm_medium, s.utm_campaign,
           s.country, s.device, s.browser, s.os, s.lang, s.is_bot
    FROM analytics_events e
    JOIN analytics_sessions s ON s.id = e.session_id
    WHERE e.website_id = ${websiteId}
      AND e.created_at >= NOW() - (${RANGES[range]})::interval
    ORDER BY e.created_at ASC
    LIMIT 100000
  `;

  const header = [
    'created_at','event_type','event_name','url_path','page_title',
    'referrer_domain','referrer_path','url_query',
    'visitor_hash','utm_source','utm_medium','utm_campaign',
    'country','device','browser','os','lang','is_bot',
  ];
  const lines = [header.join(',')];
  for (const r of rows as DbRow[]) {
    lines.push(header.map((k) => csvCell(r[k])).join(','));
  }

  const filename = `analytics-${websiteId.slice(0, 8)}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(lines.join('\n'));
}

export default withAdmin(handler);
