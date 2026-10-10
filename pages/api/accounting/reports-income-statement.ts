/**
 * Income Statement (P&L) Report API
 * GET /api/accounting/reports-income-statement
 *   ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 *   &project_id=UUID (optional)
 *   &cost_centre_id=UUID &business_unit_id=UUID (optional)
 *   &compare_start=YYYY-MM-DD&compare_end=YYYY-MM-DD (optional; not with group_by)
 *   &group_by=cc1|cc2|bu (optional; adds byDimension)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import {
  getIncomeStatement,
  getIncomeStatementByDimension,
} from '@/modules/accounting/services/reports/financialReportingService';
import { isDimensionGroupBy } from '@/modules/accounting/services/reports/dimensionPnlColumns';
import { isUuidParam } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { period_start, period_end, project_id, cost_centre_id, business_unit_id, compare_start, compare_end, group_by } = req.query;
    if (!period_start || !period_end) {
      return apiResponse.badRequest(res, 'period_start and period_end are required');
    }
    if (cost_centre_id !== undefined && !isUuidParam(cost_centre_id)) {
      return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
    }
    if (project_id !== undefined && !isUuidParam(project_id)) {
      return apiResponse.badRequest(res, 'project_id must be a valid UUID');
    }
    if (business_unit_id !== undefined && !isUuidParam(business_unit_id)) {
      return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
    }

    if (group_by !== undefined && !isDimensionGroupBy(group_by)) {
      return apiResponse.badRequest(res, 'group_by must be one of cc1, cc2, bu');
    }

    const comparePeriod = compare_start && compare_end
      ? { start: String(compare_start), end: String(compare_end) }
      : undefined;
    const opts = {
      projectId: project_id ? String(project_id) : undefined,
      costCentreId: cost_centre_id ? String(cost_centre_id) : undefined,
      businessUnitId: business_unit_id,
    };

    if (group_by !== undefined) {
      // The matrix has no comparative columns. Refuse rather than return a
      // body that silently drops the comparison the caller asked for.
      if (compare_start !== undefined || compare_end !== undefined) {
        return apiResponse.badRequest(res, 'compare_start / compare_end cannot be combined with group_by');
      }
      // One computation: the matrix carries the ungrouped report it ties to,
      // which stays the response body so existing consumers see no change.
      const m = await getIncomeStatementByDimension(
        companyId, String(period_start), String(period_end), group_by, opts,
      );
      return apiResponse.success(res, {
        ...m.report,
        byDimension: {
          groupBy: m.groupBy, members: m.members, lines: m.lines, columns: m.columns, residual: m.residual,
        },
      });
    }

    const report = await getIncomeStatement(companyId,
      String(period_start),
      String(period_end),
      opts,
      comparePeriod
    );
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Failed to get income statement', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate income statement');
  }
}

 
export default withAuth(
  withErrorHandler(
    withWriteAccess(
      withFlowMeter('report.pnl', getFlowCost('report.pnl'))(handler),
    ),
  ),
);
