/**
 * Admin Companies CSV Export
 * GET /api/admin/companies/export?search=&status=&sort_by=&sort_dir=&from=&to=
 * Every company matching the Companies list's filters (same predicates as
 * listCompanies), in its sort order, as one audited CSV (adminCsvExport).
 */

import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { csvRow, queryText, sendAuditedCsv } from '@/modules/admin/services/adminCsvExport';

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

/**
 * The sort keys the Companies list accepts (adminCompanyService ALLOWED_SORT_COLUMNS) plus plan_name, which
 * the page offers. A key not here sorts by the default rather than refusing the download; the audit row
 * records the sort actually applied.
 */
const SORT_COLUMNS: Record<string, string> = {
  name: 'c.name',
  created_at: 'c.created_at',
  status: 'c.status',
  user_count: 'user_count',
  mrr_cents: 'mrr_cents',
  plan_name: 'p.name',
};

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const search       = queryText(req.query.search);
  const statusFilter = queryText(req.query.status);
  const fromDate     = queryText(req.query.from);
  const toDate       = queryText(req.query.to);
  const requestedSort = queryText(req.query.sort_by);
  const sortBy  = requestedSort && SORT_COLUMNS[requestedSort] ? requestedSort : null;
  const sortAsc = sortBy !== null && queryText(req.query.sort_dir)?.toLowerCase() === 'asc';
  const sortCol = SORT_COLUMNS[sortBy ?? 'created_at']!;
  const searchPattern = search ? `%${search}%` : null;

  const rows = (await sql`
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
    WHERE (c.status IS DISTINCT FROM 'deleted' OR ${statusFilter}::text = 'deleted')
      AND (${statusFilter}::text IS NULL OR COALESCE(c.status,'active') = ${statusFilter})
      AND (${searchPattern}::text IS NULL
           OR c.name ILIKE ${searchPattern}
           OR c.registration_number ILIKE ${searchPattern})
      AND (${fromDate}::date IS NULL OR c.created_at >= ${fromDate}::date)
      AND (${toDate}::date   IS NULL OR c.created_at <  (${toDate}::date + INTERVAL '1 day'))
    ORDER BY ${sql.unsafe(sortCol)} ${sortAsc ? sql`ASC` : sql`DESC`}, c.id
  `) as Row[];

  const lines = rows.map((r) => csvRow([
    r.id,
    r.name,
    r.status,
    r.plan_name ?? '',
    r.mrr_cents,
    r.created_at,
    r.trial_ends_at,
    r.user_count,
  ]));

  log.info(`companies/export: ${lines.length} rows`, {}, 'admin-export');
  const today = new Date().toISOString().slice(0, 10);
  await sendAuditedCsv(req, res, {
    export: 'companies',
    filename: `companies-${today}.csv`,
    filters: {
      search, status: statusFilter, sort_by: sortBy, sort_dir: sortBy ? (sortAsc ? 'asc' : 'desc') : null,
      from: fromDate, to: toDate,
    },
    header: CSV_HEADERS,
    lines,
  });
}

export default withAdmin(handler);
