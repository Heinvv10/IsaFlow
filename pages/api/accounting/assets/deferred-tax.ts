/**
 * GET /api/accounting/assets/deferred-tax?period=YYYYMM
 * Returns deferred tax schedule by asset category.
 * Policy CA vs tax CA per category, temporary difference, deferred tax liability/asset.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { aggregateDeferredTax, type DeferredTaxCategoryRow } from '@/modules/accounting/services/items/farAfsService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const { period } = req.query as { period?: string };

  if (!period || !/^\d{6}$/.test(period)) {
    return apiResponse.badRequest(res, 'period must be YYYYMM (e.g. 202312)');
  }

  // Aggregate latest policy CA and tax CA per category at the given period
  const rows = (await sql`
    SELECT DISTINCT ON (a.category_id)
      c.code   AS category_code,
      c.name   AS category_name,
      COALESCE(c.ias16_group, 'OA') AS ias16_group,
      SUM(apl.policy_carrying_amount) OVER (PARTITION BY a.category_id) AS total_policy_ca,
      SUM(apl.tax_carrying_amount)    OVER (PARTITION BY a.category_id) AS total_tax_ca,
      COALESCE(AVG(a.deferred_tax_rate) OVER (PARTITION BY a.category_id), 0.27) AS deferred_tax_rate
    FROM asset_period_ledger apl
    JOIN assets a ON a.id = apl.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE apl.company_id = ${companyId}::UUID
      AND apl.yyyymm = ${period}
    ORDER BY a.category_id
  `) as Row[];

  const categoryRows: DeferredTaxCategoryRow[] = rows.map(r => ({
    categoryCode: String(r.category_code ?? 'OA'),
    categoryName: String(r.category_name ?? 'Other Asset'),
    ias16Group: String(r.ias16_group ?? 'OA'),
    totalPolicyCA: Number(r.total_policy_ca ?? 0),
    totalTaxCA: Number(r.total_tax_ca ?? 0),
    deferredTaxRate: Number(r.deferred_tax_rate ?? 0.27),
  }));

  const schedule = aggregateDeferredTax(categoryRows);
  const netDeferredTax = schedule.reduce((s, r) => s + r.deferredTax, 0);

  return apiResponse.success(res, { period, schedule, netDeferredTax });
}

export default withAuth(withErrorHandler(handler));
