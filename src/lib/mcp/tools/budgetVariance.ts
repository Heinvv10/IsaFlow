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

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

/** Enough exclusions to read; the total is carried separately either way. */
const EXCLUDED_SAMPLE_CAP = 200;

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
    'detail: "summary" returns sections with no rows; "standard" and "full" return the account lines.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      period_end: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (guard) return guard;
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    if (end < start) return toolError('period_end must not precede period_start');

    const detail = detailOf(args);
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
