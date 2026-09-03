/**
 * MCP read tool: budget_variance.
 *
 * The variance is only worth as much as its actual, so this one is built on a
 * raw per-account GL aggregate rather than on the income statement — see
 * budgetVarianceService for why that distinction is load-bearing here.
 *
 * The completeness statement IS the finding on these books. `accounting_budgets`
 * holds zero rows in production, because the write path had never executed: it
 * INSERTed twelve month columns that do not exist. So this tool answers "how did
 * we do against plan?" with an empty row list on every live company, and an
 * empty list reads as "nothing was over budget". The unbudgeted exclusion —
 * every account with real posted movement and no budget, with its value — is
 * what turns that into "none of your spend is under a budget at all".
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
    'READ THE EXCLUSIONS BEFORE THE ROWS. Only accounts that carry a budget appear in rows. An account with real spend and no budget cannot produce a variance, so it appears in excludedRows with reason no_budget_set and its actual value — and on a company where nobody has ever set a budget, rows is EMPTY and looks identical to a company that is perfectly on plan. unbudgeted_movement totals what is sitting outside any budget. ' +
    'The actual is posted journal-line movement per account, signed so revenue and expense are both positive when larger: the same figure the trial balance shows. It is deliberately NOT the income statement — no cost-of-sales bucketing, no other-income or finance-cost layer, no tax — because that classification layer has open defects a variance would silently inherit. Draft journals are excluded. ' +
    'Variance is signed so positive is favourable: revenue actual less budget, expense budget less actual. variance_pct is a percentage of budget, and is reported as 0 where there is no budget to be a percentage of. ' +
    'Budgets are stored per calendar month and matched to the fiscal year given by the YEAR OF period_start, so a March-February year is looked up under its opening calendar year. fiscal_year and months_covered are returned so the match can be re-derived rather than assumed. ' +
    'detail: "summary" returns totals with no rows; "standard" and "full" return the account lines.',
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
        detail: `${u.account_code} ${u.account_name} carries posted movement in this range and no budget for FY${result.fiscalYear}, so it can produce no variance.`,
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
      totals: result.totals,
      unbudgeted_accounts: result.unbudgeted.length,
      unbudgeted_movement: result.unbudgetedMovement,
    });
  },
};
