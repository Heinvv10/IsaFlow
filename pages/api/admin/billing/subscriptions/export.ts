/**
 * Admin Billing Subscriptions CSV Export
 * GET /api/admin/billing/subscriptions/export?search=&status=&plan_id=
 * Every subscription matching the Subscriptions list's filters (same predicates
 * as billingService.listSubscriptions), as one audited CSV (adminCsvExport).
 */

import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { csvRow, queryText, sendAuditedCsv, textFilterSet } from '@/modules/admin/services/adminCsvExport';

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

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const search = queryText(req.query.search);
  const status = queryText(req.query.status);
  const planId = queryText(req.query.plan_id);
  if (planId && !isUuidParam(planId)) return apiResponse.badRequest(res, 'plan_id must be a UUID');
  const searchPattern = search ? `%${search}%` : null;

  const rows = (await sql`
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
    WHERE (${status}::text IS NULL OR s.status = ${status})
      AND (${planId}::uuid IS NULL OR s.plan_id = ${planId}::uuid)
      AND (${searchPattern}::text IS NULL OR c.name ILIKE ${searchPattern})
    ORDER BY s.created_at DESC, s.id
  `) as Row[];

  const lines = rows.map((r) => csvRow([
    r.company_name,
    r.plan_name,
    r.billing_cycle,
    r.monthly_price_cents,
    r.annual_price_cents,
    r.discount_percent,
    r.status,
    r.started_at,
    r.ends_at,
  ]));

  log.info(`billing/subscriptions/export: ${lines.length} rows`, {}, 'admin-export');
  const today = new Date().toISOString().slice(0, 10);
  await sendAuditedCsv(req, res, {
    export: 'subscriptions',
    filename: `subscriptions-${today}.csv`,
    filters: { search: textFilterSet(search), status, plan_id: planId },
    header: CSV_HEADERS,
    lines,
  });
}

export default withAdmin(handler);
