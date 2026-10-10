/**
 * `profit_and_loss`'s `by_dimension` block: the columns of a DimensionPnl in
 * the tool's wire shape, and their residual against the figures the tool
 * printed above them.
 */
import type { ClassifiedFigures } from '@/modules/accounting/services/gl/accountClassification';
import {
  bandsOf,
  isZeroResidual,
  residualOf,
  type DimensionPnl,
} from '@/modules/accounting/services/reports/dimensionPnlColumns';

export function byDimensionOut(current: ClassifiedFigures, dimension: DimensionPnl) {
  // Against the figures printed above. Unfiltered they come from a different
  // query (getFinancialFigures), so a zero residual is an independent tie.
  // Filtered they are the SAME query ungrouped (getFilteredPeriodFigures), so
  // a zero residual proves only that the grouping partitions the filtered
  // lines — every line in exactly one column — not that the filtered total is
  // right. The income-statement matrix ties a filter to its own query.
  const residual = residualOf(bandsOf(current), dimension.columns);
  return {
    group_by: dimension.groupBy,
    columns: dimension.columns.map((c) => ({
      member_id: c.memberId,
      code: c.code,
      name: c.name,
      parent_code: c.parentCode,
      line_count: c.lineCount,
      turnover: c.turnover,
      otherIncome: c.otherIncome,
      costOfSales: c.costOfSales,
      grossProfit: c.grossProfit,
      operatingExpenses: c.operatingExpenses,
      depreciation: c.depreciation,
      operatingProfit: c.operatingProfit,
      otherExpenses: c.otherExpenses,
      netProfit: c.netProfit,
    })),
    residual,
    ties: isZeroResidual(residual),
  };
}
