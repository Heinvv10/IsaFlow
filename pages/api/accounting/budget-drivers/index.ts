/**
 * Budget drivers (Budgets P4 spec §5)
 * GET    ?versionId=<uuid>                → { drivers }
 * PUT    { versionId, expectedUpdatedAt, glAccountId, cc1Id, cc2Id, buId, kind, fromMonth, toMonth, rounding?, …kind fields }
 *        → { driver, updatedAt, recomputed, warnings }: sets (or replaces) the row's ONE driver
 *        kind fields: fixed { amount } · per_head { amount, headcountCostCentreId } · pct_of_line { pct, ref }
 *        · pct_of_section { pct, section, scope } · growth { pct, baseMonth }; amounts in rand, months 'YYYY-MM'
 * DELETE ?versionId=<uuid>&expectedUpdatedAt=<token>&id=<driver id> → { deleted, id, updatedAt, recomputed, warnings }
 * Writes compare-and-set the version's token first (409 BUDGET_VERSION_LOCKED, or BUDGET_VERSION_STALE
 * with `currentUpdatedAt` and `status`, before anything is written; the answer's `updatedAt` is the new token), recompute
 * its drivers and write one audit row. 400 DRIVER_CYCLE (with `path`), DRIVER_REF, DRIVER_RANGE or
 * BUDGET_VERSION_INPUT / BUDGET_GRAIN_CONFLICT; 404 for another company's version or driver. Every
 * refusal writes nothing. Writes are charged to the user's `budget-driver:<userId>` bucket
 * (120 a minute; 429 with Retry-After past it). Any member may read.
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
import { deleteDriver, listDrivers, saveDriver } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';

const Token = z.string().max(40).refine(isVersionToken, 'expectedUpdatedAt must be the updatedAt the version was read with');
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Months are YYYY-MM');
const grain = {
  glAccountId: UUID,
  cc1Id: UUID.nullable().default(null),
  cc2Id: UUID.nullable().default(null),
  buId: UUID.nullable().default(null),
};
const common = z.object({
  versionId: UUID,
  // A real timestamp, checked here: one Postgres cannot read (30 February, offset +99) would be a 500 at the compare.
  expectedUpdatedAt: Token,
  ...grain,
  fromMonth: Month,
  toMonth: Month,
  rounding: z.union([z.literal(1), z.literal(100), z.literal(1000)]).default(1),
});
const DriverSchema = z.discriminatedUnion('kind', [
  common.extend({ kind: z.literal('fixed'), amount: z.number() }),
  common.extend({ kind: z.literal('per_head'), amount: z.number(), headcountCostCentreId: UUID.nullable().default(null) }),
  common.extend({ kind: z.literal('pct_of_line'), pct: z.number(), ref: z.object(grain) }),
  common.extend({
    kind: z.literal('pct_of_section'), pct: z.number(),
    section: z.enum(['turnover', 'cost_of_sales', 'other_income', 'operating_expense', 'other_expense']),
    scope: z.enum(['same_grain', 'company']),
  }),
  common.extend({ kind: z.literal('growth'), pct: z.number(), baseMonth: Month }),
]);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  if (!['GET', 'PUT', 'DELETE'].includes(method)) return apiResponse.methodNotAllowed(res, method, ['GET', 'PUT', 'DELETE']);
  // Each write recomputes the version and writes an audit row: a runaway client is stopped at two a second.
  if (method !== 'GET' && !(await checkRateLimit(`budget-driver:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget driver changes; wait a minute and try again.');
  }
  try {
    if (method === 'PUT') {
      const parsed = DriverSchema.safeParse(req.body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      const { versionId, expectedUpdatedAt, ...line } = parsed.data;
      return apiResponse.success(res, await saveDriver(companyId, userId, { versionId, expectedUpdatedAt }, line));
    }
    const { versionId, id, expectedUpdatedAt } = req.query;
    if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'versionId must be a version id');
    if (method === 'GET') return apiResponse.success(res, await listDrivers(companyId, versionId));
    if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a driver id');
    const token = Token.safeParse(expectedUpdatedAt);
    if (!token.success) return apiResponse.badRequest(res, 'expectedUpdatedAt must be the updatedAt the version was read with');
    return apiResponse.success(res, await deleteDriver(companyId, userId, { versionId, expectedUpdatedAt: token.data }, id));
  } catch (err) {
    if (respondBudgetDriverError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
