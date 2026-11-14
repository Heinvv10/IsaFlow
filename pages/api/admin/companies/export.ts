/**
 * Admin Companies CSV Export
 * GET /api/admin/companies/export?search=&status=&plan=&sort_by=&sort_dir=&from=&to=
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
import { isRealCalendarDate } from '@/lib/validation';
import { csvRow, queryText, sendAuditedCsv, textFilterSet } from '@/modules/admin/services/adminCsvExport';

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
 * the page offers. FALLBACK_SORTS are keys the page offers that the export cannot apply yet (last_active,
 * until the list sorts by it for real): they sort by the default, created_at desc, rather than refusing the
 * download, and the audit row (`sort_fallback_from`) and the X-Export-Sort response header say so. Any other
 * key is a 400, so the audit row only records known values.
 */
const SORT_COLUMNS: Record<string, string> = {
  name: 'c.name',
  created_at: 'c.created_at',
  status: 'c.status',
  user_count: 'user_count',
  mrr_cents: 'mrr_cents',
  plan_name: 'p.name',
};
const FALLBACK_SORTS = new Set(['last_active']);
const STATUSES = new Set(['trial', 'active', 'suspended', 'cancelled', 'deleted']);

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const search       = queryText(req.query.search);
  const statusFilter = queryText(req.query.status);
  const fromDate     = queryText(req.query.from);
  const toDate       = queryText(req.query.to);
  const plan         = queryText(req.query.plan);
  const requestedSort = queryText(req.query.sort_by);
  const requestedDir  = queryText(req.query.sort_dir);
  if (statusFilter && !STATUSES.has(statusFilter)) return apiResponse.badRequest(res, 'status is not a company status');
  if (requestedSort && !SORT_COLUMNS[requestedSort] && !FALLBACK_SORTS.has(requestedSort)) {
    return apiResponse.badRequest(res, 'sort_by is not a Companies column');
  }
  if (requestedDir && requestedDir !== 'asc' && requestedDir !== 'desc') return apiResponse.badRequest(res, 'sort_dir must be asc or desc');
  for (const d of [fromDate, toDate]) {
    if (d && !isRealCalendarDate(d)) return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD');
  }
  if (plan && (await sql`SELECT 1 FROM plans WHERE code = ${plan}`).length === 0) {
    return apiResponse.badRequest(res, 'plan is not a plan code');
  }
  const honoured = requestedSort !== null && SORT_COLUMNS[requestedSort] !== undefined;
  const sortBy  = honoured ? requestedSort : 'created_at';
  const sortAsc = honoured && requestedDir === 'asc';
  const sortDir = sortAsc ? 'asc' : 'desc';
  const sortFallbackFrom = requestedSort !== null && !honoured ? requestedSort : null;
  const sortCol = SORT_COLUMNS[sortBy]!;
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
      AND (${plan}::text IS NULL OR p.code = ${plan})
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
  // No request text in a header: the requested key is on the audit row.
  res.setHeader('X-Export-Sort', `${sortBy} ${sortDir}${sortFallbackFrom ? ' (requested sort not supported; default used)' : ''}`);
  await sendAuditedCsv(req, res, {
    export: 'companies',
    filename: `companies-${today}.csv`,
    filters: {
      search: textFilterSet(search), status: statusFilter, plan, sort_by: sortBy, sort_dir: sortDir,
      sort_fallback_from: sortFallbackFrom, from: fromDate, to: toDate,
    },
    header: CSV_HEADERS,
    lines,
  });
}

export default withAdmin(handler);
