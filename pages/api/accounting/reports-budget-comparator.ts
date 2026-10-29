/**
 * GET /api/accounting/reports-budget-comparator?period_start=&period_end=
 *   [&cost_centre_id=] [&cc1_id=] [&cc2_id=] [&bu_id= | &business_unit_id=] [&version_id=]
 *
 * The budget column for the statement grid. Wraps getBudgetVariance, the
 * facade over the budgets P3 tracking engine, which aggregates posted journal
 * lines per account rather than reading the income statement — see that
 * service's header for why.
 *
 * The filter is the statement page's (budgets P3 spec §2.4, §4):
 * `cost_centre_id` is EITHER level (`cc1_id OR cc2_id`, as the income statement
 * filters its actuals), `cc1_id` / `cc2_id` are explicit levels, and
 * `business_unit_id` is the page's name for `bu_id`. A budget set above the
 * filter is never in the column: it is `unallocatedBudget`. `version_id` names
 * a version (else each year's primary). A blank value is absent; an id that is
 * not this company's is a 404, a version from another year a 400.
 *
 * `lines` is budgeted accounts followed by unbudgeted ones, because the
 * statement needs to look an account up by code regardless of which half it
 * fell into, and dropping the unbudgeted half would silently hide accounts.
 * `budgetedCount` preserves where the split fell, which is the only thing in
 * the response that says whether a budget was ever captured; `budgetAbsentYears`
 * says which years of the window have none in it, and `partialBudgetCount` how
 * many accounts are budgeted for only part of it. The route asks the facade for
 * the engine's partial-window rule (`partialWindow: 'absent'`), so this column
 * shows the budget Budget vs Actual shows for the same window and filter: a
 * budget for part of the window is withheld, never summed as if it were the
 * window's.
 *
 * Rate limited per company at the interactive limit (120 per 15 minutes, as
 * Budget vs Actual): the page reloads it on every period and filter change, so
 * the default 25 would lock an accountant out within one sitting; the page
 * coalesces changes on top of it. A refusal names its wait.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { chargeReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { respondReportRateLimited } from '@/lib/reportRateLimitResponse';
import { respondTrackingError } from '@/lib/budgetTrackingResponse';
import { UUID } from '@/lib/schemas/common';
import { getBudgetVariance, type BudgetVarianceOptions } from '@/modules/accounting/services/reports/budgetVarianceService';

const blankIsAbsent = (v: unknown) => (v === '' ? undefined : v);
const Id = z.preprocess(blankIsAbsent, UUID.optional());

const Query = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  version_id: Id,
  cost_centre_id: Id,
  cc1_id: Id,
  cc2_id: Id,
  bu_id: Id,
  business_unit_id: Id,
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  const limit = await chargeReportRateLimit(companyId, 'reports-budget-comparator', { ...INTERACTIVE_REPORT_LIMIT });
  if (!limit.admitted) {
    log.warn('Budget comparator rate limit exceeded', { companyId }, 'rateLimit');
    return respondReportRateLimited(res, limit.retryAfterSecs);
  }

  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const q = parsed.data;
  if (q.bu_id !== undefined && q.business_unit_id !== undefined && q.bu_id.toLowerCase() !== q.business_unit_id.toLowerCase()) {
    return apiResponse.badRequest(res, 'bu_id and business_unit_id name different business units');
  }
  // The engine's partial-window rule, as Budget vs Actual prints it (spec §8.2: the same budget figure).
  const opts: BudgetVarianceOptions & { partialWindow: 'absent' } = { partialWindow: 'absent' };
  if (q.version_id !== undefined) opts.versionId = q.version_id;
  if (q.cost_centre_id !== undefined) opts.costCentreId = q.cost_centre_id;
  if (q.cc1_id !== undefined) opts.cc1Id = q.cc1_id;
  if (q.cc2_id !== undefined) opts.cc2Id = q.cc2_id;
  const buId = q.bu_id ?? q.business_unit_id;
  if (buId !== undefined) opts.buId = buId;

  let result;
  try {
    result = await getBudgetVariance(companyId, q.period_start, q.period_end, opts);
  } catch (err) {
    if (respondTrackingError(res, err)) return;
    throw err;
  }

  return apiResponse.success(res, {
    fiscalYear: result.fiscalYear,
    monthKeys: result.monthKeys,
    lines: [...result.rows, ...result.unbudgeted],
    // The service's own split, carried across the wire. Flattening `rows` and
    // `unbudgeted` into one `lines` array loses the only statement anyone made
    // about whether a budget EXISTS, and a client left to infer it from
    // all-zero amounts cannot tell "no budget captured" from "budgeted at
    // zero on every line".
    budgetedCount: result.rows.length,
    postedThrough: result.postedThrough,
    version: result.version,
    unallocatedBudget: result.unallocatedBudget,
    budgetAbsentYears: result.budgetAbsentYears,
    // Accounts whose budget covers only part of the window: withheld, so in neither half of `lines`.
    partialBudgetCount: result.lines.filter((l) => l.budget_partial).length,
  });
}

export default withAuth(withErrorHandler(handler as never));
