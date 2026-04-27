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
import { log } from '@/lib/logger';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';

function defaultPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const period = typeof req.query.period === 'string' && req.query.period.length > 0
    ? req.query.period
    : defaultPeriod();
  try {
    const workbench = await getMonthEndWorkbench(companyId, period);
    return apiResponse.success(res, workbench);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build month-end workbench';
    log.error('month-end workbench failed', { error: err, companyId, period }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

export default withAuth(withErrorHandler(handler));
