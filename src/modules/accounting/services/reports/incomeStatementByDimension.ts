/**
 * The income statement as a matrix: one column per CC1 / CC2 / BU member plus
 * untagged, accounts down. Feeds the page's `group_by` and the xlsx "By …"
 * sheet.
 *
 * The ungrouped `report` comes from `getIncomeStatement` — its own query, with
 * the same filter — and `residual` is that report minus the columns. So a zero
 * residual is a tie between two separately written queries, filtered or not,
 * rather than the matrix agreeing with itself.
 */

import type { IncomeStatementReport } from '../../types/gl.types';
import { getIncomeStatement, type IncomeStatementOptions } from './incomeStatementService';
import { dimensionPnlOf, fetchDimensionAccountRows } from './dimensionPnlService';
import {
  PNL_BANDS,
  memberKey,
  residualOf,
  statementBandOf,
  type DimensionGroupBy,
  type DimensionMember,
  type PnlBands,
  type StatementBand,
} from './dimensionPnlColumns';

/** One account row of the by-dimension matrix. */
export interface IncomeStatementDimensionLine {
  band: StatementBand;
  accountCode: string;
  accountName: string;
  /** Amount per member key (member id, or `untagged`), statement sign. */
  amounts: Record<string, number>;
  total: number;
}

export interface IncomeStatementByDimension {
  periodStart: string;
  periodEnd: string;
  groupBy: DimensionGroupBy;
  /** Tagged members by code, untagged last. */
  members: DimensionMember[];
  lines: IncomeStatementDimensionLine[];
  /** Band totals per member key, plus `total`. */
  columns: Array<DimensionMember & PnlBands & { lineCount: number }>;
  /** The ungrouped statement for the same window and filter. */
  report: IncomeStatementReport;
  /**
   * The ungrouped report's bands minus the sum of the columns, to the cent.
   * Depreciation is not a band of this report, so it is not checked here.
   */
  residual: PnlBands;
}

/**
 * The matrix and the ungrouped statement it ties to, computed once each.
 * Callers that also need the plain report take `report` from the result
 * rather than calling `getIncomeStatement` a second time.
 */
export async function getIncomeStatementByDimension(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  groupBy: DimensionGroupBy,
  opts: IncomeStatementOptions = {},
): Promise<IncomeStatementByDimension> {
  const filter = {
    costCentreId: opts.costCentreId,
    businessUnitId: opts.businessUnitId,
    projectId: opts.projectId,
  };
  const report = await getIncomeStatement(companyId, periodStart, periodEnd, opts);
  const rows = await fetchDimensionAccountRows(companyId, periodStart, periodEnd, groupBy, filter);
  const pnl = await dimensionPnlOf(companyId, groupBy, rows);

  const byAccount = new Map<string, IncomeStatementDimensionLine>();
  for (const r of rows) {
    const amount = r.accountType === 'revenue' ? r.credit - r.debit : r.debit - r.credit;
    let line = byAccount.get(r.accountId);
    if (!line) {
      line = { band: statementBandOf(r), accountCode: r.accountCode, accountName: r.accountName, amounts: {}, total: 0 };
      byAccount.set(r.accountId, line);
    }
    const k = memberKey(r.memberId);
    line.amounts[k] = Math.round(((line.amounts[k] ?? 0) + amount) * 100) / 100;
    line.total = Math.round((line.total + amount) * 100) / 100;
  }
  const lines = [...byAccount.values()]
    .filter((l) => Math.abs(l.total) > 0.001 || Object.values(l.amounts).some((a) => Math.abs(a) > 0.001))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const against: PnlBands = {
    turnover: report.totalRevenue,
    otherIncome: report.totalOtherIncome,
    costOfSales: report.totalCostOfSales,
    grossProfit: report.grossProfit,
    operatingExpenses: report.totalOperatingExpenses,
    depreciation: 0,
    operatingProfit: report.operatingProfit,
    otherExpenses: report.totalOtherExpenses,
    netProfit: report.netProfit,
  };

  return {
    periodStart,
    periodEnd,
    groupBy,
    members: pnl.columns.map(({ key, memberId, code, name, parentCode }) => ({ key, memberId, code, name, parentCode })),
    lines,
    columns: pnl.columns,
    report,
    residual: residualOf(against, pnl.columns, PNL_BANDS.filter((b) => b !== 'depreciation')),
  };
}
