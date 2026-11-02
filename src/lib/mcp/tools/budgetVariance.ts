/**
 * MCP read tool: budget_variance.
 *
 * The variance is only worth as much as its actual, so this one is built on a
 * raw per-account GL aggregate rather than on the income statement — see
 * budgetVarianceService for why that distinction is load-bearing here.
 *
 * The completeness statement IS the finding wherever nobody has set a budget.
 * Such a company answers "how did we do against plan?" with an empty row list,
 * and an empty list reads as "nothing was over budget". The unbudgeted
 * exclusion — every account with real posted movement and no budget, with its
 * value — is what turns that into "none of your spend is under a budget at all".
 */
import type { McpTool } from '../types';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { buildEnvelope, figureBasis, isDetailLevel } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { filteredBudgetVariance, type BudgetVarianceFilter } from './budgetVarianceFiltered';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

/** Enough exclusions to read; the total is carried separately either way. */
const EXCLUDED_SAMPLE_CAP = 200;

const FILTER_ARGS = ['version_id', 'cc1_id', 'cc2_id', 'bu_id'] as const;

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

export const budgetVarianceTool: McpTool = {
  name: 'budget_variance',
  description:
    'Budget against actual for every revenue and expense account over a date range: the budgeted amount for the months in the range, the posted movement, and the variance between them. ' +
    'READ THE EXCLUSIONS BEFORE THE ROWS. Only accounts that carry a budget appear in rows. A deliberate zero budget is a budget: the account is a row (budgeted: true, budget_amount 0), not an exclusion. An account with real spend and no budget cannot produce a variance, so it appears in excludedRows with reason no_budget_set and its actual value — and on a company where nobody has ever set a budget, rows is EMPTY and looks identical to a company that is perfectly on plan. unbudgeted_movement totals what is sitting outside any budget. ' +
    'The actual is posted journal-line movement per account, signed so revenue and expense are both positive when larger: the same figure the trial balance shows. It is deliberately NOT the income statement, and DO NOT "improve" it into one — no cost-of-sales bucketing, no other-income or finance-cost layer, no tax. incomeStatementService has open defects in exactly the classification layer a variance would inherit, and a variance computed against a net profit already known to be wrong is worse than no variance, because it wears the authority of a reconciliation. The raw per-account aggregate borrows none of it. Draft journals are excluded. ' +
    'Each row carries two signed differences. variance is signed so positive is favourable: revenue actual less budget, expense budget less actual. movement is actual less budget for every account type, the figure the Budget vs Actual screen and CSV print; favourable (true/false) says whether it is good news. variance_pct and movement_pct are percentages of the absolute budget, and variance_pct is null where the budget is zero or absent: there is nothing to be a percentage of. ' +
    'There is no totals field: net profit is sections.net_profit. sections carries revenue, expense and net_profit (revenue less expenses), each with budget, actual, variance, movement, variance_pct, movement_pct and favourable, and they cover EVERY account in the range, budgeted or not: they do not foot to the rows, and excludedRows carry an actual amount, not a variance. Read sections, not a sum of rows, for the whole picture. ' +
    'Budgets are stored per calendar month (budget_month_amounts), not per fiscal year: the budget for a range is the sum of the budgeted months from the month of period_start to the month of period_end, a month counted whole, across as many financial years as the range spans. A financial year can be 1-15 months long (a 14-month transition year after a change of year end), and any window sums exactly its months. fiscal_year is the financial year holding period_start and months_covered lists the YYYY-MM months summed, so the match can be re-derived rather than assumed. ' +
    'detail: "summary" returns sections with no rows; "standard" and "full" return the account lines. ' +
    'VERSION AND DIMENSIONS (optional; with none of them, everything above holds exactly). Without version_id each financial year is read on its primary budget version; version_id reads that version instead (any status), and the whole range must lie in its financial year. ' +
    'cc1_id, cc2_id and bu_id filter by EXPLICIT dimension level, ANDed: an actual counts when its journal line carries that cost centre at that level (cc1_id = CC1, cc2_id = CC2) and that business unit; untagged lines fall outside a filter that names the dimension. ' +
    'A budget counts under a filter when it was set at the filter or below it (a CC2 budget counts under its CC1). A budget set ABOVE the filter (at company level, or at CC1 when filtering by a CC2) is never split or apportioned: it is reported as unallocated_budget (income and expense separately) and its account appears in excludedRows with reason budget_above_filter. ' +
    'With any of these four arguments the range is read in WHOLE MONTHS: a range that cuts a budget month (period_start not the 1st, or period_end not a month end) has no budget at all (splits_budget_month true), and so does one reaching a financial year with no budget (budget_absent_years) or whose budget is all at other members of the filter (budget_outside_filter_years). In all three the actual of every account is in excludedRows with reason budget_absent. An account budgeted for only part of the range is excluded with reason budget_partial. unbudgeted_accounts and unbudgeted_movement count reason no_budget_set only; excludedTotal counts every reason. ' +
    'Those responses add version (id, name, kind, status, isPrimary), dimension_filter, unallocated_budget (with a dimension), budget_absent_years, budget_outside_filter_years and splits_budget_month; a section budget is null where any account under it is above the filter or partial.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      period_end: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      version_id: { type: 'string', format: 'uuid', description: 'A budget version of the range\'s financial year; default each year\'s primary.' },
      cc1_id: { type: 'string', format: 'uuid', description: 'Filter: a CC1 cost centre (explicit level).' },
      cc2_id: { type: 'string', format: 'uuid', description: 'Filter: a CC2 cost centre (explicit level).' },
      bu_id: { type: 'string', format: 'uuid', description: 'Filter: a business unit.' },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['period_start', 'period_end'], uuid: [...FILTER_ARGS] });
    if (guard) return guard;
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    if (end < start) return toolError('period_end must not precede period_start');

    // strArg passes over an empty or non-string value: a filter dropped that way would answer company-wide.
    for (const key of FILTER_ARGS) {
      if (args[key] !== undefined && strArg(args, key) === undefined) return toolError(`invalid ${key}`);
    }

    const detail = detailOf(args);
    // Only arguments actually given: an absent one is never defaulted into the call, so with none the
    // default path below runs exactly as it did before they existed.
    const filter: BudgetVarianceFilter = {};
    for (const [arg, key] of [['version_id', 'versionId'], ['cc1_id', 'cc1Id'], ['cc2_id', 'cc2Id'], ['bu_id', 'buId']] as const) {
      const value = strArg(args, arg);
      if (value !== undefined) filter[key] = value;
    }
    if (Object.keys(filter).length > 0) return filteredBudgetVariance(ctx.companyId, start, end, detail, filter);

    const result = await getBudgetVariance(ctx.companyId, start, end);

    const excludedRows: ExcludedRow[] = result.unbudgeted
      .slice(0, EXCLUDED_SAMPLE_CAP)
      .map((u) => ({
        id: u.account_id,
        reason: 'no_budget_set',
        detail: `${u.account_code} ${u.account_name} carries posted movement in this range and no budget for any month of it, so it can produce no variance.`,
        amount: u.actual_amount,
      }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : result.rows,
      rowsTotal: result.rows.length,
      universeTotal: result.universeTotal,
      excludedTotal: result.unbudgeted.length,
      detail,
      as_at: end,
      // The last posting the range actually contains — what to re-derive against.
      posted_through: result.postedThrough
        ? `${result.postedThrough}T00:00:00.000Z`
        : NO_LEDGER_ROWS,
      excludedRows,
      figureBasis: figureBasis('budget.actual.v1'),
    });

    return ok({
      ...envelope,
      period_start: start,
      period_end: end,
      fiscal_year: result.fiscalYear,
      months_covered: result.monthKeys,
      // No `totals`: net profit is sections.net_profit (docs/plans/budgets/00-shared-contract.md, decision 19).
      // A field whose meaning changed silently is worse than one that is gone.
      sections: result.sections,
      unbudgeted_accounts: result.unbudgeted.length,
      unbudgeted_movement: result.unbudgetedMovement,
    });
  },
};
