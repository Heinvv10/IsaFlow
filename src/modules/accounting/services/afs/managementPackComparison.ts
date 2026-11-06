/**
 * What `comparison_mode` puts in a generated management pack (budgets P3 PR-D, spec §4 Packs), and
 * the `income_vs_budget` / `budget_variance` sections.
 *
 * Budget figures are the tracking engine's for the pack month and the primary version; nothing here
 * computes one. Printed: Var R = actual − budget, with Favourable / Unfavourable beside it, because
 * a pack table has no colour. `null` from the engine prints "—"; a budgeted zero prints R 0.00, which
 * is why these tables use `formatMoney`, not `formatStatementFigure` (it prints a zero as a dash).
 */
import * as Sentry from '@sentry/nextjs';
import { formatPct } from '@/lib/format/money';
import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { BudgetVersionError } from '../budgets/budgetVersionTypes';
import { buildBudgetTrackingReport } from '../budgets/tracking/budgetTrackingService';
import { TrackingError, type BudgetTrackingReport, type TrackingFigures, type TrackingLine } from '../budgets/tracking/trackingTypes';
import type { ManagementPackConfig, NoteContent, NoteContentBlock, NoteContentTable } from './afsTypes';
import { NO_ACTIVITY, packSectionLabel } from './managementPackSections';
import type { StatementTable } from './managementPackStatements';

export interface ComparisonPlan {
  priorMonth: boolean;
  priorYear: boolean;
  budget: boolean;
}

export type PackBudget =
  | { kind: 'report'; report: BudgetTrackingReport }
  /** `fault`: the engine FAILED (a database fault or a bug) rather than refusing the month; the pack is then held for review. */
  | { kind: 'unavailable'; reason: string; fault: boolean };

type IncomeAgg = Record<string, unknown>;

const TOP_LINES = 10;
const DASH = '—';
const FIGURE_HEADERS = ['Actual', 'Budget', 'Var R', 'Var %', 'Position'];

export function comparisonPlan(mode: ManagementPackConfig['comparisonMode']): ComparisonPlan {
  return {
    priorMonth: mode !== 'prior_year',
    priorYear: mode === 'prior_year' || mode === 'all_three',
    budget: mode === 'budget' || mode === 'all_three',
  };
}

/** The sections that print budget figures; they take no AI commentary, whose prompt forbids budgets. */
export function isBudgetSection(sectionType: string): boolean {
  return sectionType === 'income_vs_budget' || sectionType === 'budget_variance';
}

/** The month a year earlier, 'YYYY-MM'. */
export function samePeriodLastYear(period: string): string {
  const [year = '2000', month = '01'] = period.split('-');
  return `${Number(year) - 1}-${month}`;
}

/** What a budget section prints when the engine gives no report. Fixed text: a pack goes to external
 *  recipients, and engine messages can carry database text. The real error is logged. */
export const BUDGET_UNAVAILABLE = 'Budget figures are unavailable for this month.';

/**
 * The engine's report for the pack month, or `unavailable`. Budget sections are on by default, so a
 * company that never set up a budget must still get its pack: no failure here stops it. The read
 * runs in a savepoint, so a failed query does not abort the request's transaction (inside withAuth)
 * that the pack is then written in; outside a request (the cron) the savepoint is a plain call.
 */
/** Reports a fault that the pack survives (a budget or statement read that failed) to Bugsink, when Sentry is on. */
export function capturePackFault(err: unknown, companyId: string): void {
  if (process.env.SENTRY_ENABLED !== 'true') return;
  try {
    Sentry.captureException(err, { tags: { company_id: companyId, route: 'management-pack' } });
  } catch (sentryErr) {
    log.warn('management pack: Sentry capture failed', { error: sentryErr instanceof Error ? sentryErr.message : String(sentryErr) }, 'managementPackComparison');
  }
}

export async function loadPackBudget(companyId: string, period: string, now?: Date): Promise<PackBudget> {
  try {
    const report = await withSavepoint('mgmt_pack_budget', () =>
      buildBudgetTrackingReport(companyId, { period: 'month', month: period }, now));
    return { kind: 'report', report };
  } catch (err) {
    const refusal = err instanceof TrackingError || err instanceof BudgetVersionError;
    const fields = { companyId, period, errorClass: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message : String(err) };
    if (refusal) log.warn('management pack: the budget engine refused the pack month', fields, 'managementPackComparison');
    else {
      log.error('management pack: the budget engine failed; budget sections print the unavailable sentence', fields, 'managementPackComparison');
      // The pack still goes out, so a bug here would otherwise only be a log line: report it (as deferredEnd does).
      capturePackFault(err, companyId);
    }
    return { kind: 'unavailable', reason: BUDGET_UNAVAILABLE, fault: !refusal };
  }
}

const money = (n: unknown): string => formatMoney(Number(n ?? 0));
const orDash = (n: number | null): string => (n === null ? DASH : formatMoney(n));

function position(favourable: boolean | null): string {
  if (favourable === null) return DASH;
  return favourable ? 'Favourable' : 'Unfavourable';
}

const figureCells = (f: TrackingFigures): string[] => [
  formatMoney(f.actual), orDash(f.budget), orDash(f.variance),
  f.variancePct === null ? DASH : formatPct(f.variancePct), position(f.favourable),
];

const versionName = (r: BudgetTrackingReport): string | null => (r.version ? `${r.version.name} · ${r.version.status}` : null);

function budgetNotes(r: BudgetTrackingReport): NoteContentBlock[] {
  const notes: string[] = [];
  const version = versionName(r);
  if (version) notes.push(`Budget version: ${version}.`);
  if (r.window.inProgress) {
    const { month, actualsTo } = r.window.inProgress;
    notes.push(actualsTo ? `${month} is in progress; actuals posted through ${actualsTo}.` : `${month} is in progress; no actuals posted yet.`);
  }
  const { unbudgetedCount: count, unbudgetedActual: { income, expense } } = r.notices;
  if (count > 0) {
    const parts = [income !== 0 ? `income ${formatMoney(income)}` : '', expense !== 0 ? `expenses ${formatMoney(expense)}` : ''].filter(Boolean);
    notes.push(`${count === 1 ? '1 account carries' : `${count} accounts carry`} actuals but no budget: ${parts.join(', ')}.`);
  }
  return notes.map((text) => ({ type: 'paragraph', text }));
}

/** The sentence that stands in for a budget table, or null when there is one to print. */
function noBudgetSentence(budget: PackBudget): string | null {
  if (budget.kind === 'unavailable') return budget.reason;
  return budget.report.notices.noVersion ? `No budget for FY${budget.report.window.fiscalYear} in this pack's month.` : null;
}

export function budgetBandBlocks(budget: PackBudget): NoteContentBlock[] {
  const sentence = noBudgetSentence(budget);
  if (sentence !== null || budget.kind !== 'report') return [{ type: 'paragraph', text: sentence ?? '' }];
  const table: NoteContentTable = {
    type: 'table',
    headers: ['', ...FIGURE_HEADERS],
    rows: budget.report.bands.map((b) => [b.label, ...figureCells(b)]),
  };
  return [table, ...budgetNotes(budget.report)];
}

/** The budgeted lines off budget, largest |variance| first, at most ten. */
export function topVarianceLines(lines: readonly TrackingLine[]): TrackingLine[] {
  return lines
    .filter((l) => l.variance !== null && l.variance !== 0)
    .sort((a, b) => Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0) || a.accountCode.localeCompare(b.accountCode))
    .slice(0, TOP_LINES);
}

/** `varianceNotes`: the approved variance notes (budgets P5, `managementPackVarianceNotes.ts`), printed under the table. */
export function budgetLineBlocks(budget: PackBudget, varianceNotes: readonly NoteContentBlock[] = []): NoteContentBlock[] {
  const sentence = noBudgetSentence(budget);
  if (sentence !== null || budget.kind !== 'report') return [{ type: 'paragraph', text: sentence ?? '' }];
  const top = topVarianceLines(budget.report.lines);
  if (top.length === 0) {
    return [{ type: 'paragraph', text: 'No budgeted account is off budget this month.' }, ...varianceNotes, ...budgetNotes(budget.report)];
  }
  const table: NoteContentTable = {
    type: 'table',
    headers: ['Account', ...FIGURE_HEADERS],
    rows: top.map((l) => [`${l.accountCode} ${l.accountName}`, ...figureCells(l)]),
  };
  return [table, ...varianceNotes, ...budgetNotes(budget.report)];
}

/** What the section's `data_snapshot` keeps: the engine's figures as printed. */
export function budgetSnapshot(budget: PackBudget): Record<string, unknown> {
  if (budget.kind === 'unavailable') return { unavailable: budget.reason };
  const r = budget.report;
  return {
    version: versionName(r),
    noVersion: r.notices.noVersion,
    month: r.window.months[0] ?? null,
    bands: r.bands.map(({ key, actual, budget: b, variance, favourable }) => ({ key, actual, budget: b, variance, favourable })),
  };
}

export interface IncomeComparison {
  income: IncomeAgg;
  priorIncome: IncomeAgg;
  priorYearIncome: IncomeAgg | null;
}

/** The section: the statement table (`managementPackStatements`), then the band table unless `income_vs_budget` prints it. */
export function incomeStatementContent(
  statement: StatementTable,
  plan: ComparisonPlan,
  budget: PackBudget | null,
  bandsPrintedElsewhere: boolean,
): NoteContent {
  const blocks: NoteContentBlock[] = [statement.table];
  if (statement.empty) blocks.push({ type: 'paragraph', text: NO_ACTIVITY.income_statement });
  if (plan.budget && budget && !bandsPrintedElsewhere) blocks.push(...budgetBandBlocks(budget));
  return { title: packSectionLabel('income_statement'), blocks };
}

/** What the AI is told the prior period was. Prior month alone stays the bare aggregate it has always received. */
export function narrativePrior(data: IncomeComparison, plan: ComparisonPlan): { label: string; revenue: number; priorData: IncomeAgg } {
  const { priorIncome, priorYearIncome } = data;
  if (plan.priorYear && priorYearIncome) {
    return {
      label: plan.priorMonth ? 'prior month' : 'the same month last year',
      revenue: Number((plan.priorMonth ? priorIncome : priorYearIncome).revenue ?? 0),
      priorData: plan.priorMonth
        ? { prior_month: priorIncome, same_month_last_year: priorYearIncome }
        : { same_month_last_year: priorYearIncome },
    };
  }
  return { label: 'prior month', revenue: Number(priorIncome.revenue ?? 0), priorData: priorIncome };
}
