/**
 * Month-End Workbench API.
 * GET /api/accounting/month-end-workbench?period=YYYY-MM
 *
 * Returns aggregated close-of-month status for the authenticated company.
 * Read-only — no mutations.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';

function defaultPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const requested = typeof req.query.period === 'string' ? req.query.period : '';
  if (requested && !PERIOD_RE.test(requested)) {
    return apiResponse.badRequest(res, 'period must be YYYY-MM');
  }
  const period = requested || defaultPeriod();

  // Let withErrorHandler surface 500 on real failures — only validation
  // errors return 400. The service catches per-card errors internally via
  // Promise.allSettled, so getMonthEndWorkbench only throws for things like
  // a missing companyId or DB connectivity loss, which are 500-class.
  const workbench = await getMonthEndWorkbench(companyId, period);
  return apiResponse.success(res, workbench);
}

export default withAuth(withErrorHandler(handler));
