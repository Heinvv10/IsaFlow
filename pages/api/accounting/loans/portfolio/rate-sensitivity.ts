/**
 * Portfolio-level IFRS 7 rate-sensitivity disclosure.
 *
 * GET — for every active variable-rate loan, runs ±100bp / ±200bp shocks
 * and returns the aggregate 12-month interest exposure under each
 * scenario. Fixed-rate loans are included with zero delta.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { computeRateSensitivity } from '@/modules/accounting/services/loans/loanComplianceService';
import type { LoanInputs, RatePoint } from '@/lib/amortisation/types';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'GET') return apiResponse.badRequest(res, 'Method not allowed');

  const loans = (await sql`
    SELECT l.*, lrp.effective_date, lrp.rate AS curve_rate
    FROM loans l
    LEFT JOIN LATERAL (
      SELECT effective_date, rate
      FROM loan_rate_points
      WHERE curve_id = l.curve_id
      ORDER BY effective_date DESC
      LIMIT 1
    ) lrp ON true
    WHERE l.company_id = ${companyId} AND l.status = 'active'
  `) as Row[];

  let base12m = 0;
  const shocks = { minus200bp: 0, minus100bp: 0, plus100bp: 0, plus200bp: 0 };

  for (const row of loans) {
    const inputs: LoanInputs = {
      id: String(row.id),
      principal: parseFloat(String(row.principal)),
      startDate: String(row.start_date).slice(0, 10),
      termMonths: Number(row.term_months),
      rateMode: String(row.rate_mode) as LoanInputs['rateMode'],
      margin: parseFloat(String(row.margin ?? '0')),
      fixedRate: row.fixed_rate != null ? parseFloat(String(row.fixed_rate)) : undefined,
      residual: parseFloat(String(row.residual ?? '0')),
      recurringSkipMonths: Array.isArray(row.recurring_skip_months) ? (row.recurring_skip_months as number[]) : [],
      dayCount: String(row.day_count) as LoanInputs['dayCount'],
      repriceMode: String(row.reprice_mode) as LoanInputs['repriceMode'],
      skipMode: String(row.skip_mode) as LoanInputs['skipMode'],
      lumpMode: String(row.lump_mode) as LoanInputs['lumpMode'],
    };
    const curve: RatePoint[] = row.curve_rate != null
      ? [{ effectiveDate: String(row.effective_date).slice(0, 10), rate: parseFloat(String(row.curve_rate)) }]
      : [{ effectiveDate: inputs.startDate, rate: inputs.fixedRate ?? 0 }];

    const s = computeRateSensitivity(inputs, curve);
    base12m += s.baseInterest12m;
    shocks.minus200bp += s.minus200bp.interestDelta;
    shocks.minus100bp += s.minus100bp.interestDelta;
    shocks.plus100bp  += s.plus100bp.interestDelta;
    shocks.plus200bp  += s.plus200bp.interestDelta;
  }

  return apiResponse.success(res, {
    activeLoans: loans.length,
    baseInterest12m: Math.round(base12m * 100) / 100,
    shocks: {
      minus200bp: { interestDelta: Math.round(shocks.minus200bp * 100) / 100 },
      minus100bp: { interestDelta: Math.round(shocks.minus100bp * 100) / 100 },
      plus100bp:  { interestDelta: Math.round(shocks.plus100bp  * 100) / 100 },
      plus200bp:  { interestDelta: Math.round(shocks.plus200bp  * 100) / 100 },
    },
  });
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
