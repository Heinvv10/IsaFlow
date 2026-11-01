/**
 * Budget headcount (Budgets P4 decision 7)
 * GET  ?versionId=<uuid>[&costCentreId=<uuid>] → { costCentreId, months: [{ month, payroll, hires, total }], asOf }
 *      COUNTS ONLY: payroll actives (read-only) + the version's planned hires per month of its year, at
 *      the company or one cost centre. Never names, ID numbers or pay. Budget writers only: a reader gets
 *      { costCentreId, perHeadRestricted: true } and payroll is not read, since counts beside a per_head
 *      row's totals give the per-head rate back (POPIA, decision 15: perHeadAccess).
 * POST { versionId, expectedUpdatedAt } → { headcountAsOf, updatedAt, recomputed, warnings }: "Refresh headcount", a
 *      recompute of the version's drivers (per_head reads payroll again) whose audit row records
 *      `headcountAsOf`. Token compared-and-set first (409 BUDGET_VERSION_LOCKED / STALE); charged to `budget-driver:<userId>`
 *      (120 a minute; 429 with Retry-After past it).
 * 404 for another company's version; 400 for a cost centre that is not the company's.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { isUuidParam } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetDriverError } from '@/lib/budgetDriverResponse';
import { refreshHeadcount } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { readHeadcount } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';
import { perHeadAccessOf } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';

const RefreshSchema = z.object({
  versionId: UUID,
  expectedUpdatedAt: z.string().max(40).refine(isVersionToken, 'expectedUpdatedAt must be the updatedAt the version was read with'),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    if (req.method === 'GET') {
      const { versionId, costCentreId } = req.query;
      if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'versionId must be a version id');
      if (costCentreId !== undefined && costCentreId !== '' && !isUuidParam(costCentreId)) {
        return apiResponse.badRequest(res, 'costCentreId must be a cost centre id');
      }
      const scope = typeof costCentreId === 'string' && costCentreId !== '' ? costCentreId : null;
      return apiResponse.success(res, await readHeadcount(companyId, versionId, scope, perHeadAccessOf((req as CompanyAuthedRequest).companyRole)));
    }
    if (req.method === 'POST') {
      if (!(await checkRateLimit(`budget-driver:${userId}`, { max: 120, windowSecs: 60 }))) {
        res.setHeader('Retry-After', '60');
        return apiResponse.tooManyRequests(res, 'Too many budget driver changes; wait a minute and try again.');
      }
      const parsed = RefreshSchema.safeParse(req.body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      return apiResponse.success(res, await refreshHeadcount(companyId, userId, parsed.data));
    }
  } catch (err) {
    if (respondBudgetDriverError(res, err)) return;
    throw err;
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
