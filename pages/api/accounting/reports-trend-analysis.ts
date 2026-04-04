/**
 * Trend Analysis API
 * GET /api/accounting/reports-trend-analysis?metric=revenue|expenses|netProfit|cash&months=6
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { analyzeTrend } from '@/modules/accounting/services/trendAnalysisService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const METRIC_QUERIES: Record<string, string> = {
  revenue: "SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END)",
  expenses: "SUM(CASE WHEN ga.account_code LIKE '5%' THEN jl.debit - jl.credit ELSE 0 END)",
  netProfit: "SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit WHEN ga.account_code LIKE '5%' THEN -(jl.debit - jl.credit) ELSE 0 END)",
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const metric = (req.query.metric as string) || 'revenue';
  const months = Math.min(12, Math.max(3, parseInt(String(req.query.months || '6'), 10)));

  const now = new Date();

  // Build month descriptors upfront
  const monthSlots = Array.from({ length: months }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    const from = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const to = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    const label = date.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
    return { from, to, label };
  });

  // Parallelize all month queries in one round-trip
  const results = await Promise.all(
    monthSlots.map(({ from, to }) =>
      metric === 'cash'
        ? sql`
            SELECT COALESCE(SUM(jl.debit - jl.credit), 0) as val
            FROM gl_journal_lines jl
            JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
            JOIN gl_accounts ga ON ga.id = jl.gl_account_id
            WHERE je.company_id = ${companyId} AND je.status = 'posted'
              AND ga.account_code = '1110' AND je.entry_date <= ${to}::date
          `
        : sql`
            SELECT
              COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
              COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' THEN jl.debit - jl.credit ELSE 0 END), 0) as expenses
            FROM gl_journal_lines jl
            JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
            JOIN gl_accounts ga ON ga.id = jl.gl_account_id
            WHERE je.company_id = ${companyId} AND je.status = 'posted'
              AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
          `
    )
  );

  const dataPoints: Array<{ period: string; value: number }> = monthSlots.map(({ label }, idx) => {
    const [r] = results[idx] as Row[];
    let value = 0;
    if (metric === 'cash') value = parseFloat(r?.val || '0');
    else if (metric === 'revenue') value = parseFloat(r?.revenue || '0');
    else if (metric === 'expenses') value = parseFloat(r?.expenses || '0');
    else if (metric === 'netProfit') value = parseFloat(r?.revenue || '0') - parseFloat(r?.expenses || '0');
    return { period: label, value: Math.round(value * 100) / 100 };
  });

  const analysis = analyzeTrend(dataPoints);

  return apiResponse.success(res, { metric, months, analysis });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
