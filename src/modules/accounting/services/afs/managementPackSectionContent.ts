// src/modules/accounting/services/afs/managementPackSectionContent.ts
// What the generator stores for each management pack section: its content, the data snapshot behind
// it, and the data its AI commentary is told. Every section is titled from the section vocabulary.
import type { IncomeStatementReport, BalanceSheetReport } from '../../types/gl.types';
import {
  budgetBandBlocks, budgetLineBlocks, budgetSnapshot, incomeStatementContent, isBudgetSection,
  type ComparisonPlan, type PackBudget,
} from './managementPackComparison';
import { NO_ACTIVITY, STATEMENT_UNAVAILABLE, packSectionLabel } from './managementPackSections';
import {
  balanceSheetTable, incomeStatementTable, longDate, type StatementColumn,
} from './managementPackStatements';
import type { KpiResult, NoteContent, NoteContentBlock } from './afsTypes';

/** A report for the pack month and, as the comparison mode asks, for the month before and the same month a year earlier. */
export interface Periodic<R> { current: R; prior: R | null; yearAgo: R | null }

export interface PackData {
  kpis: KpiResult[];
  income: Record<string, unknown>;
  priorIncome: Record<string, unknown>;
  priorYearIncome: Record<string, unknown> | null;
  /** Null when the section is not enabled: the report is not read. */
  incomeReports: Periodic<IncomeStatementReport> | null;
  balanceReports: Periodic<BalanceSheetReport> | null;
  plan: ComparisonPlan;
  budget: PackBudget | null;
  /** The approved variance notes printed under the budget_variance table (budgets P5). */
  varianceNotes: NoteContentBlock[];
  enabledSections: string[];
}

/** Sections that carry data of their own, and so a snapshot and AI commentary; the rest have no generator yet. */
const COMMENTED = ['kpi_scorecard', 'income_statement', 'balance_sheet'];
/** Commentary on a statement is never written about a statement that could not be read. */
export const hasCommentary = (sectionType: string, data: PackData): boolean =>
  COMMENTED.includes(sectionType)
  && (sectionType !== 'balance_sheet' || data.balanceReports !== null)
  && (sectionType !== 'income_statement' || data.incomeReports !== null);

/** The statement's own turnover, cost of sales and net profit: what the snapshot stores and the AI is told. Empty when there is no report. */
export function incomeAggregate(report: IncomeStatementReport | null | undefined): Record<string, unknown> {
  return report ? { revenue: report.totalRevenue, cogs: report.totalCostOfSales, net_profit: report.netProfit } : {};
}

export function renderSection(sectionType: string, data: PackData): NoteContent {
  const title = packSectionLabel(sectionType);
  const changeOnLastYear = data.plan.priorYear;
  switch (sectionType) {
    case 'kpi_scorecard':
      return {
        title,
        blocks: [{
          type: 'table',
          headers: ['KPI', 'Value', 'Trend', 'RAG'],
          rows: data.kpis.map(k => [k.label, k.formatted, k.trend, k.rag]),
        }],
      };
    case 'income_statement':
      if (!data.incomeReports) return { title, blocks: [{ type: 'paragraph', text: STATEMENT_UNAVAILABLE }] };
      return incomeStatementContent(
        incomeStatementTable(incomeColumns(data.incomeReports), changeOnLastYear), data.plan, data.budget,
        data.enabledSections.includes('income_vs_budget'),
      );
    case 'balance_sheet': {
      if (!data.balanceReports) return { title, blocks: [{ type: 'paragraph', text: STATEMENT_UNAVAILABLE }] };
      const statement = balanceSheetTable(balanceColumns(data.balanceReports), changeOnLastYear);
      return { title, blocks: [statement.table, ...(statement.empty ? [{ type: 'paragraph' as const, text: NO_ACTIVITY.balance_sheet }] : [])] };
    }
    case 'income_vs_budget':
      return { title, blocks: data.budget ? budgetBandBlocks(data.budget) : [] };
    case 'budget_variance':
      return { title, blocks: data.budget ? budgetLineBlocks(data.budget, data.varianceNotes) : [] };
    default:
      // No generator yet (cover, executive summary, cash flow, ageing, ...): the viewers print a sentence for an empty section.
      return { title, blocks: [] };
  }
}

const MONTH_LABELS = { current: 'This month', prior: 'Prior month', yearAgo: 'Same month last year' } as const;

function columnsOf<R>(p: Periodic<R> | null, label: (slot: keyof typeof MONTH_LABELS, report: R) => string): StatementColumn<R>[] {
  if (!p) return [];
  return [
    { label: label('current', p.current), report: p.current },
    ...(p.prior ? [{ label: label('prior', p.prior), report: p.prior }] : []),
    ...(p.yearAgo ? [{ label: label('yearAgo', p.yearAgo), report: p.yearAgo }] : []),
  ];
}

const incomeColumns = (p: Periodic<IncomeStatementReport> | null) => columnsOf(p, (slot) => MONTH_LABELS[slot]);
/** A balance sheet is at a date, so its columns are headed by the date. */
const balanceColumns = (p: Periodic<BalanceSheetReport> | null) => columnsOf(p, (_slot, r) => longDate(r.asAtDate));

/** The balance sheet's totals, the figures behind the statement; also what its AI commentary is told. */
export function balanceFigures(r: BalanceSheetReport | undefined): Record<string, unknown> {
  return r ? { asAtDate: r.asAtDate, totalAssets: r.totalAssets, totalLiabilities: r.totalLiabilities, totalEquity: r.totalEquity } : {};
}

/** The data_snapshot stored with a section: its own figures, never another section's. */
export function renderSnapshot(sectionType: string, data: PackData): Record<string, unknown> {
  if (data.budget && isBudgetSection(sectionType)) return budgetSnapshot(data.budget);
  switch (sectionType) {
    case 'income_statement': return data.income;
    case 'balance_sheet': return balanceFigures(data.balanceReports?.current);
    case 'kpi_scorecard': return { kpis: data.kpis.map((k) => ({ key: k.key, value: k.value, priorValue: k.priorValue })) };
    default: return {};
  }
}

/** What the AI is told for a section's commentary: the section's own figures and the prior period's, when it has one. */
export function commentaryInput(
  sectionType: string, data: PackData, incomePrior: Record<string, unknown>,
): { sectionData: Record<string, unknown>; priorData: Record<string, unknown> | null } {
  if (sectionType === 'kpi_scorecard') {
    return { sectionData: { kpis: data.kpis.map((k) => ({ label: k.label, value: k.formatted, trend: k.trend, rag: k.rag })) }, priorData: null };
  }
  if (sectionType === 'balance_sheet') {
    const b = data.balanceReports;
    const prior = b?.prior ?? b?.yearAgo ?? null;
    return { sectionData: balanceFigures(b?.current), priorData: prior ? balanceFigures(prior) : null };
  }
  return { sectionData: data.income, priorData: incomePrior };
}
