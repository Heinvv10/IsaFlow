/**
 * Income Statement (P&L) Report API
 * GET /api/accounting/reports-income-statement
 *   ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 *   &project_id=UUID (optional)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getIncomeStatement } from '@/modules/accounting/services/financialReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { period_start, period_end, project_id, cost_centre_id, compare_start, compare_end } = req.query;
    if (!period_start || !period_end) {
      return apiResponse.badRequest(res, 'period_start and period_end are required');
    }

    const comparePeriod = compare_start && compare_end
      ? { start: String(compare_start), end: String(compare_end) }
      : undefined;

    const report = await getIncomeStatement(
      String(period_start),
      String(period_end),
      {
        projectId: project_id ? String(project_id) : undefined,
        costCentreId: cost_centre_id ? String(cost_centre_id) : undefined,
      },
      comparePeriod
    );
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Failed to get income statement', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate income statement');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
