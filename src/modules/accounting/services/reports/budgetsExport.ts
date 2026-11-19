/**
 * `budget_versions` and `budgets`, the GL export's budget tables (schema
 * isaflow-budgets-1.0), as at today, built whole. No SQL of their own: every
 * fact comes from the budget services, so the export reads what the grid and
 * budget_variance read.
 *
 *  - versions: budgets/budgetVersions.listVersions (every version, every status).
 *  - cells: budgets/gridReadModel.loadGridCells per version, as a server read
 *    (no viewer, so no holder filter): revenue / expense accounts only, months
 *    of the version's own year only, the cells budget_variance sums.
 *  - per_head accounts: budgets/drivers/driverRepository.listDriverLines; only
 *    the line's account and kind are used, never its rate (D7).
 *  - account codes: budgets/budgetRefResolve.loadChartRefs.
 *
 * Shaping, the per-head roll-up, the sort and the cents control total are
 * budgetsExportRows (pure). Reads run SEQUENTIALLY: one pg client per request.
 */
import { fmtDate } from '@/lib/fmtDate';
import { listVersions } from '../budgets/budgetVersions';
import { loadGridCells } from '../budgets/gridReadModel';
import { listDriverLines } from '../budgets/drivers/driverRepository';
import { loadChartRefs } from '../budgets/budgetRefResolve';
import {
  BUDGETS_COLUMNS, BUDGET_VERSIONS_COLUMNS, budgetRows, budgetVersionRows, budgetVersionsSummary, budgetsSummary,
  type BudgetVersionsSummary, type BudgetsExportRow, type BudgetsSummary, type VersionCells,
} from './budgetsExportRows';

export interface BudgetVersionsResult {
  columns: readonly string[];
  rows: BudgetsExportRow[];
  summary: BudgetVersionsSummary;
}

export interface BudgetsResult {
  columns: readonly string[];
  rows: BudgetsExportRow[];
  summary: BudgetsSummary;
}

export async function buildBudgetVersions(companyId: string, asAtStr: string = fmtDate(new Date())): Promise<BudgetVersionsResult> {
  const rows = budgetVersionRows(await listVersions(companyId));
  return { columns: BUDGET_VERSIONS_COLUMNS, rows, summary: budgetVersionsSummary(rows, asAtStr) };
}

export async function buildBudgets(companyId: string, asAtStr: string = fmtDate(new Date())): Promise<BudgetsResult> {
  const versions = await listVersions(companyId);
  const perVersion: VersionCells[] = [];
  for (const v of versions) {
    const { cells } = await loadGridCells(companyId, { versionId: v.id });
    const lines = await listDriverLines(companyId, v.id);
    const perHeadAccountIds = new Set(lines.filter((l) => l.kind === 'per_head').map((l) => l.glAccountId));
    perVersion.push({ versionId: v.id, cells, perHeadAccountIds });
  }
  const chart = await loadChartRefs(companyId);
  const rows = budgetRows(perVersion, new Map(chart.accounts.map((a) => [a.id, a.code])));
  return { columns: BUDGETS_COLUMNS, rows, summary: budgetsSummary(rows, asAtStr) };
}
