/**
 * Admin Billing Subscriptions CSV Export
 * GET /api/admin/billing/subscriptions/export
 * Streams all subscriptions as a CSV file.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

const CSV_HEADERS = [
  'company_name',
  'plan_name',
  'billing_cycle',
  'monthly_price_cents',
  'annual_price_cents',
  'discount_percent',
  'status',
  'started_at',
  'ends_at',
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

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="subscriptions-${today}.csv"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-store');

  res.write(CSV_HEADERS.map(escapeCell).join(',') + '\n');

  const CHUNK_SIZE = 500;
  let offset = 0;
  let written = 0;

  try {
    for (;;) {
      const rows = await sql`
        SELECT
          c.name                                 AS company_name,
          p.name                                 AS plan_name,
          s.billing_cycle,
          p.monthly_price_cents,
          p.annual_price_cents,
          COALESCE(s.discount_percent, 0)        AS discount_percent,
          s.status,
          s.current_period_start                 AS started_at,
          s.current_period_end                   AS ends_at
        FROM subscriptions s
        INNER JOIN companies c ON c.id = s.company_id
        INNER JOIN plans p     ON p.id = s.plan_id
        ORDER BY s.created_at DESC
        LIMIT ${CHUNK_SIZE} OFFSET ${offset}
      `;

      if (rows.length === 0) break;

      const lines = (rows as Row[]).map((r) => [
        r.company_name,
        r.plan_name,
        r.billing_cycle,
        r.monthly_price_cents,
        r.annual_price_cents,
        r.discount_percent,
        r.status,
        toIsoOrEmpty(r.started_at),
        toIsoOrEmpty(r.ends_at),
      ].map(escapeCell).join(','));

      res.write(lines.join('\n') + '\n');
      written += rows.length;
      offset  += CHUNK_SIZE;

      if (rows.length < CHUNK_SIZE) break;
    }

    log.info(`billing/subscriptions/export: wrote ${written} rows`, {}, 'admin-export');
  } catch (err) {
    log.error('billing/subscriptions/export failed', { error: err }, 'admin-export');
  }

  res.end();
}

export default withAdmin(handler);
