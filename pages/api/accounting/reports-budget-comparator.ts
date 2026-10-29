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
 * Query: real calendar dates in YEAR_MIN..YEAR_MAX, `period_end` not before
 * `period_start`, at most MAX_CUSTOM_MONTHS (24) months, as Budget vs Actual's
 * custom range; anything else is a 400 before any query.
 *
 * The route asks the facade for the engine's rule (`partialWindow: 'absent'`),
 * so this column shows the budget Budget vs Actual shows for the same window
 * and filter. `lines` carries every account with the engine's `budget_verdict`;
 * `budgetedCount` is how many carry a budget, the only statement in the
 * response that a budget EXISTS. `budgetAbsentYears` names the years of the
 * window with none in it, `partialBudgetCount` (the engine's) the accounts
 * budgeted for only part of it, `splitsMonth` a window that cuts a budget month
 * (no window budget then: budgets are set by whole month), and `bands` the
 * engine's band and profit-total budgets for the statement's band rows.
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
import { MAX_CUSTOM_MONTHS, YEAR_MAX, YEAR_MIN } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { budgetMonthKeysInWindow, monthEnd } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { getBudgetVariance, type BudgetVarianceTrackedOptions } from '@/modules/accounting/services/reports/budgetVarianceService';

const blankIsAbsent = (v: unknown) => (v === '' ? undefined : v);
const Id = z.preprocess(blankIsAbsent, UUID.optional());

/**
 * A real calendar date (2026-02-31 is not one) in YEAR_MIN..YEAR_MAX; read as text, no Date built.
 * Each message is a sentence on its own: the page shows the server's reason as it is.
 */
const day = (label: string) =>
  // The shape check ABORTS: a continuable failure would still run the refines, and `monthEnd` throws on a
  // string that is not a date (a 500 with a stack trace for user input).
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { error: `${label} must be a date, YYYY-MM-DD`, abort: true })
    .refine((d) => d <= monthEnd(`${d.slice(0, 7)}-01`), `${label} must be a real calendar date`)
    .refine((d) => Number(d.slice(0, 4)) >= YEAR_MIN && Number(d.slice(0, 4)) <= YEAR_MAX, `${label}'s year must lie in ${YEAR_MIN}-${YEAR_MAX}`);

/** What a bad id says, per dimension: the page shows the server's sentence, not a field name and a parser's words. */
const ID_SUBJECT: Record<string, string> = {
  version_id: 'budget version', cost_centre_id: 'cost centre', cc1_id: 'cost centre', cc2_id: 'cost centre', bu_id: 'business unit', business_unit_id: 'business unit',
};
const invalidId = (field: string): string => `That ${ID_SUBJECT[field] ?? 'filter'} is not valid.`;

const Query = z.object({
  period_start: day('The start date'),
  period_end: day('The end date'),
  version_id: Id,
  cost_centre_id: Id,
  cc1_id: Id,
  cc2_id: Id,
  bu_id: Id,
  business_unit_id: Id,
})
  .refine((q) => q.period_end >= q.period_start, { message: 'The end date must not precede the start date', path: ['period_end'] })
  // The Budget vs Actual page's own cap on a custom range: a window is a report, not a ledger dump.
  .refine((q) => budgetMonthKeysInWindow(q.period_start, q.period_end).length <= MAX_CUSTOM_MONTHS,
    { message: `A window can be at most ${MAX_CUSTOM_MONTHS} months`, path: ['period_end'] });

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
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    const first = Object.entries(fieldErrors).find(([, v]) => v && v.length > 0);
    // Every message is a whole sentence the page prints as it is: a window's own, or "That cost centre is not valid."
    const message = first ? (first[0].startsWith('period_') ? first[1]![0]! : invalidId(first[0])) : 'That request is not valid.';
    return apiResponse.badRequest(res, message, fieldErrors);
  }

  const q = parsed.data;
  if (q.bu_id !== undefined && q.business_unit_id !== undefined && q.bu_id.toLowerCase() !== q.business_unit_id.toLowerCase()) {
    return apiResponse.badRequest(res, 'bu_id and business_unit_id name different business units');
  }
  // The engine's partial-window rule, as Budget vs Actual prints it (spec §8.2: the same budget figure).
  const opts: BudgetVarianceTrackedOptions = { partialWindow: 'absent' };
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
    // Every line, each with the engine's `budget_verdict` (budgeted / unbudgeted / partial /
    // above-filter / absent), so the column prints a budget, a zero, or "—" with its reason.
    lines: result.lines,
    // The service's own split, carried across the wire: the only statement anyone made about
    // whether a budget EXISTS. A client left to infer it from all-zero amounts cannot tell "no
    // budget captured" from "budgeted at zero on every line".
    budgetedCount: result.rows.length,
    postedThrough: result.postedThrough,
    version: result.version,
    unallocatedBudget: result.unallocatedBudget,
    budgetAbsentYears: result.budgetAbsentYears,
    budgetOutsideFilterYears: result.budgetOutsideFilterYears,
    splitsMonth: result.splitsMonth,
    partialBudgetCount: result.partialBudgetCount,
    // The engine's band and profit-total budgets, for the statement's band rows (null: absent).
    bands: result.bands,
  });
}

export default withAuth(withErrorHandler(handler as never));
