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
 *  - the rolled-up accounts (budgetsExportRows.rolledUpAccounts, D7): every
 *    version's driver lines (budgets/drivers/driverRepository.listDriverLines;
 *    only account, kind, ref and section are used, never a rate) and the
 *    account bands (budgets/gridReadAccounts.loadAccountBands). One set for
 *    the whole company, applied to every version.
 *  - account codes: budgets/budgetRefResolve.loadChartRefs.
 *
 * A version whose financial year is not in the registry (loadGridCells:
 * FiscalYearLabelUnknownError, thrown before any SQL fails) is skipped with a
 * warning naming it rather than failing the whole export; its driver lines
 * still count towards the rolled-up set. Any other failure fails the export.
 *
 * Shaping, the per-head roll-up, the sort and the cents control total are
 * budgetsExportRows (pure). Reads run SEQUENTIALLY: one pg client per request.
 */
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { FiscalYearLabelUnknownError } from '../gl/fiscalYearRegistry';
import { loadAccountBands } from '../budgets/gridReadAccounts';
import { listVersions } from '../budgets/budgetVersions';
import { loadGridCells } from '../budgets/gridReadModel';
import { listDriverLines } from '../budgets/drivers/driverRepository';
import { loadChartRefs } from '../budgets/budgetRefResolve';
import {
  BUDGETS_COLUMNS, BUDGET_VERSIONS_COLUMNS, budgetRows, budgetVersionRows, budgetVersionsSummary, budgetsSummary,
  rolledUpAccounts, type BudgetVersionsSummary, type BudgetsExportRow, type BudgetsSummary, type RollupDriverLine,
  type VersionCells,
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

/** The version's cells; null (with a warning) when its financial year is not in the registry. */
async function versionCells(companyId: string, versionId: string): Promise<VersionCells['cells'] | null> {
  try {
    return (await loadGridCells(companyId, { versionId })).cells;
  } catch (err) {
    if (!(err instanceof FiscalYearLabelUnknownError)) throw err;
    log.warn('Budget export skipped a version: its financial year is not in the registry', {
      companyId, versionId, fiscalYear: err.fiscalYear,
    }, 'accounting-api');
    return null;
  }
}

export async function buildBudgets(companyId: string, asAtStr: string = fmtDate(new Date())): Promise<BudgetsResult> {
  const versions = await listVersions(companyId);
  const perVersion: VersionCells[] = [];
  const lines: RollupDriverLine[] = [];
  for (const v of versions) {
    for (const l of await listDriverLines(companyId, v.id)) {
      lines.push({ glAccountId: l.glAccountId, kind: l.kind, ref: l.ref, section: l.section });
    }
    const cells = await versionCells(companyId, v.id);
    if (cells !== null) perVersion.push({ versionId: v.id, cells });
  }
  const rolled = rolledUpAccounts(lines, await loadAccountBands(companyId));
  const chart = await loadChartRefs(companyId);
  const rows = budgetRows(perVersion, rolled, new Map(chart.accounts.map((a) => [a.id, a.code])));
  return { columns: BUDGETS_COLUMNS, rows, summary: budgetsSummary(rows, asAtStr) };
}
