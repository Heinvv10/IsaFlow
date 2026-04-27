/**
 * Portfolio Workbench API.
 * GET /api/accounting/portfolio-workbench?period=YYYY-MM
 *
 * Returns close-of-month status across every client the authenticated user
 * has access to. Read-only — no mutations.
 *
 * Note: this endpoint is keyed by userId, not companyId. The active company
 * context is irrelevant here; we walk every company the user has membership
 * in via company_users.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getPortfolioWorkbench } from '@/modules/accounting/services/workbench/portfolioWorkbenchService';

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
  // withAuth guarantees req.user.id when it doesn't 401, but a defensive
  // check costs nothing and protects this route if auth wrapping ever
  // regresses (e.g. a future refactor mounts this handler outside withAuth).
  const userId = (req as CompanyAuthedRequest).user?.id;
  if (!userId) {
    return apiResponse.unauthorized(res);
  }
  const requested = typeof req.query.period === 'string' ? req.query.period : '';
  if (requested && !PERIOD_RE.test(requested)) {
    return apiResponse.badRequest(res, 'period must be YYYY-MM (month 01–12)');
  }
  const period = requested || defaultPeriod();

  const portfolio = await getPortfolioWorkbench(userId, period);
  return apiResponse.success(res, portfolio);
}

export default withAuth(withErrorHandler(handler));
