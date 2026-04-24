/**
 * GET /api/admin/billing/payg/companies
 *
 * Returns every company on the PAYG plan with:
 *   - current balance, auto-topup status, nudge level
 *   - month-to-date Flows debited (sum of this-month `debit` ledger rows)
 *
 * Filters: ?nudgeLevel=red&autoTopup=enabled&search=foo
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import type { PlatformAdminRequest } from '@/lib/auth';

interface Row {
  company_id: string;
  company_name: string;
  balance_flows: number;
  auto_topup_enabled: boolean;
  nudge_level: string;
  month_flows_used: number;
  month_reset_at: Date;
  month_debited: number;
}

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const nudgeLevel = typeof req.query.nudgeLevel === 'string' ? req.query.nudgeLevel : null;
  const autoTopup  = req.query.autoTopup === 'enabled' ? true
                   : req.query.autoTopup === 'disabled' ? false
                   : null;
  const search     = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const searchLike = search ? `%${search}%` : null;

  const rows = (await sql<Row>`
    WITH month_debits AS (
      SELECT company_id, COALESCE(SUM(-flows), 0)::int AS month_debited
        FROM flow_ledger
       WHERE type = 'debit'
         AND created_at > date_trunc('month', now())
       GROUP BY company_id
    )
    SELECT c.id               AS company_id,
           c.name             AS company_name,
           w.balance_flows,
           w.auto_topup_enabled,
           w.nudge_level,
           w.month_flows_used,
           w.month_reset_at,
           COALESCE(md.month_debited, 0) AS month_debited
      FROM companies c
      JOIN subscriptions s ON s.company_id = c.id AND s.status = 'active'
      JOIN plans p         ON p.id = s.plan_id AND p.code = 'payg'
 LEFT JOIN flow_wallet w    ON w.company_id = c.id
 LEFT JOIN month_debits md  ON md.company_id = c.id
     WHERE (${nudgeLevel}::text IS NULL OR w.nudge_level = ${nudgeLevel})
       AND (${autoTopup}::boolean IS NULL OR w.auto_topup_enabled = ${autoTopup})
       AND (${searchLike}::text IS NULL OR c.name ILIKE ${searchLike})
     ORDER BY w.nudge_level DESC NULLS LAST, c.name
  `) as Row[];

  const companies = rows.map((r) => ({
    companyId:         r.company_id,
    companyName:       r.company_name,
    balance:           r.balance_flows ?? 0,
    autoTopupEnabled:  r.auto_topup_enabled ?? false,
    nudgeLevel:        r.nudge_level ?? 'none',
    monthFlowsUsed:    r.month_flows_used ?? 0,
    monthResetAt:      r.month_reset_at,
    monthDebitedCents: (r.month_debited ?? 0) * 10,  // R0.10 / Flow = 10 cents
  }));

  return apiResponse.success(res, { companies });
}

export default withAdmin(handler);
