/**
 * `profit_and_loss` v2 — a WRAP of the OWNED classifier, with the coverage
 * exception that says how much the statement is worth.
 *
 * WHICH IMPLEMENTATION, AND WHY IT IS NOT THE OBVIOUS ONE. There are two P&L
 * implementations in this codebase:
 *
 *   reports/incomeStatementService#getIncomeStatement
 *     A two-way split. Everything revenue-typed is turnover, and every expense
 *     that is not cost of sales is an operating expense — so other income
 *     reaches gross profit, and finance cost and tax sit inside operating
 *     expenses. The income-statement page, reports-management-accounts and AFS
 *     all consume this shape.
 *
 *   gl/accountClassification#aggregateFigures, via financialFiguresService
 *     The full layer: turnover apart from other income, and cost of sales apart
 *     from operating expenses apart from finance cost / tax / other. It also
 *     counts the accounts whose subtype is unknown. AFS's figures come through
 *     here.
 *
 * This tool consumes the SECOND, deliberately, and the divergence is recorded
 * in `contracts/figures.ts` rather than left to be discovered. It is
 * PRESENTATIONAL: the two agree on the bottom line to the cent on both
 * production companies, and differ only in which band a figure sits in. The
 * owners of `revenue.period.v1` and `costofsales.period.v1` stay with
 * `getIncomeStatement`, because the page still consumes that shape and moving
 * them would make the registry lie about what the UI does. The successor is the
 * income-statement convergence PR.
 *
 * THE COVERAGE EXCEPTION IS THE POINT OF THIS TOOL, not an addition to it.
 * Every band above is chosen from `account_subtype`, and on these books the
 * subtypes barely exist: Velocity Fibre's gross profit is revenue less 2.4% of
 * its costs, with 100% of its revenue and 97.6% of its expenses on accounts
 * nobody has classified. So the coverage is present at EVERY detail level
 * including `summary`, it cannot be suppressed, and nothing is excluded from
 * any total — an unclassified expense is still an expense.
 */
import type { McpTool } from '../types';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import {
  getClassificationCoverage,
  type CoverageSide,
} from '@/modules/accounting/services/reports/classificationCoverageService';
import { getLedgerPostedThrough } from '@/modules/accounting/services/reports/postedThroughService';
import {
  priorPeriod,
  priorYearPeriod,
  type PeriodWindow,
} from '@/modules/accounting/services/reports/priorPeriod';
import { buildEnvelope, figureBasis, isDetailLevel, type DetailLevel } from '@/lib/mcp/contracts';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** Above this share of unclassified value, the bands are not worth acting on. */
const RELIABLE_THRESHOLD = 0.1;

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

/** The share of a side's value sitting on accounts nobody classified. */
function share(side: CoverageSide): number {
  if (side.totalAmount === 0) return 0;
  return Math.abs(side.unclassifiedAmount) / Math.abs(side.totalAmount);
}

const DESCRIPTION = [
  'Income statement for a date range, LAYERED: turnover, other income, cost of sales, operating expenses, and finance cost / tax reported below the operating line — so operatingProfit means what it says and other income never reaches gross profit.',
  'IMPLEMENTATION, and it differs from the UI on purpose. This wraps gl/accountClassification#aggregateFigures, the classifier AFS uses. The income-statement PAGE consumes reports/incomeStatementService#getIncomeStatement, which splits two ways: it counts other income as turnover and puts finance cost and tax inside operating expenses. The two agree on the BOTTOM LINE to the cent — the difference is which band a figure sits in, not its value — and the divergence is recorded in the figure registry with a named successor. Expect operatingExpenses here to be lower than the page shows by exactly financeCost + tax.',
  'classificationCoverage is MANDATORY and present at every detail level, because every band above is chosen from account_subtype and on these books the subtypes barely exist. On one production company 100% of revenue and 97.6% of expenses sit on accounts with no classification, and its classified cost of sales is 2.4% of total costs — so its gross profit is revenue less 2.4% of what it spent. That figure is not a bug; the code did what the chart of accounts told it. READ THE COVERAGE BEFORE ACTING ON ANY BAND. reliable is false when more than 10% of either side is unclassified. Nothing is excluded from any total: an unclassified expense is still an expense, and the classification is the finding rather than a filter.',
  'compare: "prior_period" is the preceding whole calendar period (March compares to February, Q2 to Q1), and "prior_year" is the same window one year earlier. Or pass compare_start and compare_end explicitly. This is NOT a rolling window: the page computes its comparative in milliseconds and compares March against 29 January to 28 February, so February never appears as itself.',
].join(' ');

export const profitAndLossTool: McpTool = {
  name: 'profit_and_loss',
  description: DESCRIPTION,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date', description: 'YYYY-MM-DD. Required.' },
      period_end: { type: 'string', format: 'date', description: 'YYYY-MM-DD. Required.' },
      compare: {
        type: 'string',
        enum: ['prior_period', 'prior_year'],
        description: 'Add a comparative computed on the calendar. Ignored when compare_start/compare_end are given.',
      },
      compare_start: { type: 'string', format: 'date', description: 'Explicit comparative start.' },
      compare_end: { type: 'string', format: 'date', description: 'Explicit comparative end.' },
      cost_centre_id: { type: 'string', description: 'Restrict every figure to one cost centre.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const periodStart = strArg(args, 'period_start');
    const periodEnd = strArg(args, 'period_end');
    if (!periodStart || !periodEnd) {
      return toolError('period_start and period_end are required (YYYY-MM-DD)');
    }
    // Casts validated BEFORE any query: a read tool runs with no savepoint.
    const bad = guardCastableArgs(args, {
      date: ['period_start', 'period_end', 'compare_start', 'compare_end'],
      uuid: ['cost_centre_id'],
    });
    if (bad) return bad;
    if (periodEnd < periodStart) return toolError('period_end must not precede period_start');

    const compareStart = strArg(args, 'compare_start');
    const compareEnd = strArg(args, 'compare_end');
    const compareMode = strArg(args, 'compare');

    let comparative: PeriodWindow | null = null;
    if (compareStart !== undefined || compareEnd !== undefined) {
      if (compareStart === undefined || compareEnd === undefined) {
        return toolError('compare_start and compare_end must be given together');
      }
      // 'YYYY-MM-DD' compares correctly as text. A comparative overlapping the
      // reporting period is not a comparative, and accepting one produces
      // variances between two windows sharing days.
      if (compareEnd >= periodStart) return toolError('compare_end must be earlier than period_start');
      comparative = { start: compareStart, end: compareEnd };
    } else if (compareMode === 'prior_period') {
      comparative = priorPeriod(periodStart, periodEnd);
    } else if (compareMode === 'prior_year') {
      comparative = priorYearPeriod(periodStart, periodEnd);
    }

    const costCentreId = strArg(args, 'cost_centre_id');
    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';

    // SEQUENTIAL: every read runs on the one pg client the request transaction
    // holds, and issuing a query on a client already executing one is
    // deprecated in node-postgres and corrupts the savepoint stack here.
    // companyId from ctx ONLY.
    const current = (await getFinancialFigures(ctx.companyId, periodStart, periodEnd)).period;
    const prior =
      comparative === null
        ? null
        : (await getFinancialFigures(ctx.companyId, comparative.start, comparative.end)).period;
    const coverage = await getClassificationCoverage(
      ctx.companyId, periodStart, periodEnd, costCentreId,
    );
    const postedThrough = await getLedgerPostedThrough(ctx.companyId, periodEnd);

    const operatingProfit = round2(
      current.revenue + current.otherIncome - current.costOfSales - current.operatingExpenses,
    );

    // The rows ARE the named unclassified accounts. There is no line-item page
    // here: the statement is a set of totals, and the only thing worth paging
    // is the exception.
    const rows = [
      ...coverage.revenue.accounts.map((a) => ({ ...a, side: 'revenue' as const })),
      ...coverage.expense.accounts.map((a) => ({ ...a, side: 'expense' as const })),
    ];
    const universeTotal =
      coverage.revenue.unclassifiedAccountCount + coverage.expense.unclassifiedAccountCount;

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      detail,
      as_at: periodEnd,
      posted_through: postedThrough,
      universeTotal,
      // The named list is capped; the COUNT is complete. Without this the
      // identity would raise a fault whose cause is the cap, not lost rows.
      excludedTotal: Math.max(universeTotal - rows.length, 0),
    });

    const sideOut = (side: CoverageSide) => ({
      total: side.totalAmount,
      classified: side.classifiedAmount,
      unclassified: side.unclassifiedAmount,
      unclassifiedShare: Math.round(share(side) * 10000) / 10000,
      unclassifiedAccountCount: side.unclassifiedAccountCount,
      accounts: side.accounts,
      truncated: side.truncated,
    });

    return ok({
      ...envelope,
      period_start: periodStart,
      period_end: periodEnd,
      cost_centre_id: costCentreId ?? null,
      turnover: round2(current.revenue),
      otherIncome: round2(current.otherIncome),
      costOfSales: round2(current.costOfSales),
      grossProfit: round2(current.grossProfit),
      operatingExpenses: round2(current.operatingExpenses),
      depreciation: round2(current.depreciation),
      operatingProfit,
      /** Finance cost, tax and other expense — the band below operating. */
      otherExpenses: round2(current.otherExpenses),
      netProfit: round2(current.netProfit),
      classificationCoverage: {
        revenue: sideOut(coverage.revenue),
        expense: sideOut(coverage.expense),
        // A single flag a reader can branch on before quoting any band.
        reliable:
          share(coverage.revenue) <= RELIABLE_THRESHOLD
          && share(coverage.expense) <= RELIABLE_THRESHOLD,
      },
      ...(prior === null || comparative === null
        ? {}
        : {
            comparative: {
              period_start: comparative.start,
              period_end: comparative.end,
              turnover: round2(prior.revenue),
              otherIncome: round2(prior.otherIncome),
              costOfSales: round2(prior.costOfSales),
              grossProfit: round2(prior.grossProfit),
              operatingExpenses: round2(prior.operatingExpenses),
              otherExpenses: round2(prior.otherExpenses),
              netProfit: round2(prior.netProfit),
            },
            netProfitVariance: round2(current.netProfit - prior.netProfit),
          }),
      figureBases: {
        turnover: figureBasis('revenue.period.v1'),
        otherIncome: figureBasis('otherincome.period.v1'),
        costOfSales: figureBasis('costofsales.period.v1'),
        otherExpenses: figureBasis('financecost.period.v1'),
        tax: figureBasis('tax.period.v1'),
      },
    });
  },
};
