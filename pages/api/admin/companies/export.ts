/**
 * Admin Companies CSV Export
 * GET /api/admin/companies/export
 * Streams all companies as a CSV file with optional status and date-range filters.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

const CSV_HEADERS = [
  'id',
  'name',
  'status',
  'plan_name',
  'mrr_cents',
  'created_at',
  'trial_ends_at',
  'user_count',
];

function escapeCell(value: unknown): string {
  if (value == null) return '""';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function toIsoOrEmpty(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { status, from, to } = req.query;
  const statusFilter = typeof status === 'string' && status.trim() ? status.trim() : null;
  const fromDate     = typeof from === 'string' && from.trim() ? from.trim() : null;
  const toDate       = typeof to   === 'string' && to.trim()   ? to.trim()   : null;

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="companies-${today}.csv"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-store');

  // Write header row immediately
  res.write(CSV_HEADERS.map(escapeCell).join(',') + '\n');

  const CHUNK_SIZE = 500;
  let offset = 0;
  let written = 0;

  try {
    while (true) {
      const rows = await sql`
        SELECT
          c.id,
          c.name,
          COALESCE(c.status, 'active')                          AS status,
          p.name                                                AS plan_name,
          COALESCE(
            CASE
              WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
              WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
              ELSE 0
            END, 0
          )::int                                                AS mrr_cents,
          c.created_at,
          c.trial_ends_at,
          (SELECT COUNT(*) FROM company_users cu WHERE cu.company_id = c.id)::int AS user_count
        FROM companies c
        LEFT JOIN subscriptions s ON s.company_id = c.id AND s.status IN ('active','trial')
        LEFT JOIN plans p ON p.id = s.plan_id
        WHERE c.status IS DISTINCT FROM 'deleted'
          AND (${statusFilter}::text IS NULL OR COALESCE(c.status,'active') = ${statusFilter})
          AND (${fromDate}::date IS NULL OR c.created_at >= ${fromDate}::date)
          AND (${toDate}::date   IS NULL OR c.created_at <  (${toDate}::date + INTERVAL '1 day'))
        ORDER BY c.created_at DESC
        LIMIT ${CHUNK_SIZE} OFFSET ${offset}
      `;

      if (rows.length === 0) break;

      const lines = (rows as Row[]).map((r) => [
        r.id,
        r.name,
        r.status,
        r.plan_name ?? '',
        r.mrr_cents,
        toIsoOrEmpty(r.created_at),
        toIsoOrEmpty(r.trial_ends_at),
        r.user_count,
      ].map(escapeCell).join(','));

      res.write(lines.join('\n') + '\n');
      written += rows.length;
      offset  += CHUNK_SIZE;

      if (rows.length < CHUNK_SIZE) break;
    }

    log.info(`companies/export: wrote ${written} rows`, { statusFilter, fromDate, toDate }, 'admin-export');
  } catch (err) {
    log.error('companies/export failed', { error: err }, 'admin-export');
    // Headers already sent — cannot send a JSON error; just end the stream
  }

  res.end();
}

export default withAdmin(handler);
