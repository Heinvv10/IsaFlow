/**
 * budget_variance with `version_id`, `cc1_id`, `cc2_id` or `bu_id` (budgets P3 PR-F, spec §4 MCP):
 * the tracking engine's filtered, whole-month view (`getBudgetVariance(…, { partialWindow: 'absent' })`),
 * the same reading the income statement's Budget column takes under a filter. Without any of them
 * the tool keeps its default path untouched (`budgetVariance.ts`, byte-identical output).
 *
 * Every verdict is the engine's, copied: a line budgeted above the filter, or for only part of the
 * window, is a NAMED exclusion carrying its actual, never a silent gap and never apportioned; a year
 * with no budget, or a range that cuts a budget month, leaves no window budget at all and says so.
 */
import { getBudgetVariance, type BudgetVarianceTrackedResult } from '@/modules/accounting/services/reports/budgetVarianceService';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { buildEnvelope, figureBasis } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import type { McpToolResult } from '../types';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';
const EXCLUDED_SAMPLE_CAP = 200;

export interface BudgetVarianceFilter {
  versionId?: string;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

const EXCLUSION_DETAIL: Record<'unbudgeted' | 'above-filter' | 'partial', [reason: string, detail: string]> = {
  unbudgeted: ['no_budget_set', 'carries posted movement in this range and no budget for any month of it, so it can produce no variance.'],
  'above-filter': ['budget_above_filter', 'is budgeted only above this filter (at company level, or at a level the filter names more finely), so its budget is not split to the filter; it is in unallocated_budget, never apportioned.'],
  partial: ['budget_partial', 'is budgeted for only part of this range (some of its financial years, or at another grain in another version), so no budget for the whole range is stated.'],
};

function exclusions(result: BudgetVarianceTrackedResult): ExcludedRow[] {
  return result.lines
    .filter((l): l is typeof l & { budget_verdict: keyof typeof EXCLUSION_DETAIL } => l.budget_verdict in EXCLUSION_DETAIL)
    .map((l) => {
      const [reason, detail] = EXCLUSION_DETAIL[l.budget_verdict];
      return { id: l.account_id, reason, detail: `${l.account_code} ${l.account_name} ${detail}`, amount: l.actual_amount };
    });
}

/** The engine's refusals as tool errors: an id that is not this company's reads as any other miss. */
function refusal(err: unknown): McpToolResult | null {
  if (err instanceof TrackingError) return toolError(err.status === 404 ? NOT_FOUND : err.message);
  if (err instanceof BudgetVersionError) return toolError(err.status === 404 ? NOT_FOUND : err.message);
  return null;
}

export async function filteredBudgetVariance(
  companyId: string,
  start: string,
  end: string,
  detail: DetailLevel,
  filter: BudgetVarianceFilter,
): Promise<McpToolResult> {
  let result: BudgetVarianceTrackedResult;
  try {
    result = await getBudgetVariance(companyId, start, end, { partialWindow: 'absent', ...filter });
  } catch (err) {
    const answer = refusal(err);
    if (answer) return answer;
    throw err;
  }
  const excluded = exclusions(result);
  const dimensioned = filter.cc1Id !== undefined || filter.cc2Id !== undefined || filter.buId !== undefined;

  const envelope = buildEnvelope({
    rows: detail === 'summary' ? [] : result.rows,
    rowsTotal: result.rows.length,
    universeTotal: result.universeTotal,
    excludedTotal: excluded.length,
    detail,
    as_at: end,
    posted_through: result.postedThrough ? `${result.postedThrough}T00:00:00.000Z` : NO_LEDGER_ROWS,
    excludedRows: excluded.slice(0, EXCLUDED_SAMPLE_CAP),
    figureBasis: figureBasis('budget.actual.v1'),
  });

  return ok({
    ...envelope,
    period_start: start,
    period_end: end,
    fiscal_year: result.fiscalYear,
    months_covered: result.monthKeys,
    version: result.version,
    dimension_filter: { cc1_id: filter.cc1Id ?? null, cc2_id: filter.cc2Id ?? null, bu_id: filter.buId ?? null },
    ...(dimensioned ? { unallocated_budget: result.unallocatedBudget } : {}),
    // Why the range has no budget, when it has none: a year in it with no budget, a year whose budget is all
    // at other members of the filter, or a range that cuts a budget month (budgets are set by whole month).
    budget_absent_years: result.budgetAbsentYears,
    budget_outside_filter_years: result.budgetOutsideFilterYears,
    splits_budget_month: result.splitsMonth,
    sections: result.sections,
    unbudgeted_accounts: result.unbudgeted.length,
    unbudgeted_movement: result.unbudgetedMovement,
  });
}
