/**
 * The budget export tables' rows (schema isaflow-budgets-1.0, the FibreFlow
 * contract): PURE. budgetsExport gathers the inputs from the budget services;
 * this shapes, rolls up, sorts and totals them.
 *
 * `budget_versions`: one row per version, by Version_ID. Updated_At is the
 * version token exactly as the budget services give it (P1's UTC ISO text with
 * microseconds); Approved_At / Locked_At blank when null.
 *
 * `budgets`: one row per cell the grid reads (gridReadModel.loadGridCells:
 * revenue / expense accounts, months of the version's own year), every
 * version, natural sign, its amount_source. PER-HEAD ROLL-UP (product decision
 * D7, salary privacy): in a version, an account with ANY per_head driver line
 * is exported only as ONE company-level row per month (CC1 / CC2 / BU blank),
 * Amount = Σ every cell of that account in that month, whatever its source or
 * dimension member, Source `per_head_rollup`. None of its dimension rows
 * appears, or subtracting the other rows would reveal the per-head part. No
 * rate and no headcount are ever read here. The roll-up conserves the total.
 *
 * Money: amounts are summed in integer cents, never as floats; a row carries
 * rand as a number, which the CSV writes with exactly two decimals.
 */
import type { BudgetVersion } from '../budgets/budgetVersionTypes';
import type { GridCell } from '../budgets/gridReadTypes';
import type { ExportValue } from './glLineExportRows';

export const BUDGETS_SCHEMA_VERSION = 'isaflow-budgets-1.0';
export const PER_HEAD_ROLLUP_SOURCE = 'per_head_rollup';

export const BUDGET_VERSIONS_COLUMNS: readonly string[] = [
  'Version_ID', 'Fiscal_Year', 'Name', 'Kind', 'Status', 'Is_Primary', 'Updated_At', 'Approved_At', 'Locked_At',
  'Schema_Version',
];

export const BUDGETS_COLUMNS: readonly string[] = [
  'Version_ID', 'GL_Account_ID', 'GL_Account_Code', 'Month', 'CC1_ID', 'CC2_ID', 'BU_ID', 'Amount', 'Source',
  'Schema_Version',
];

export type BudgetsExportRow = Record<string, ExportValue>;

export interface BudgetVersionsSummary {
  table: 'budget_versions';
  schemaVersion: string;
  asAt: string;
  rowCount: number;
}

export interface BudgetsSummary {
  table: 'budgets';
  schemaVersion: string;
  asAt: string;
  rowCount: number;
  /** Σ Amount over every row, summed in integer cents. */
  controlTotal: number;
}

export type ExportedVersion = Pick<BudgetVersion,
  'id' | 'fiscalYear' | 'name' | 'kind' | 'status' | 'isPrimary' | 'updatedAt' | 'approvedAt' | 'lockedAt'>;

/** One version's cells and the accounts carrying a per_head driver line in it. */
export interface VersionCells {
  versionId: string;
  cells: readonly GridCell[];
  perHeadAccountIds: ReadonlySet<string>;
}

/** Rand with at most two decimals → integer cents (exact for any NUMERIC(15,2) value and its sums). */
const toCentsExact = (rand: number): number => Math.round(rand * 100);
const fromCentsExact = (cents: number): number => (cents === 0 ? 0 : cents / 100);

/** Text order, a null before any text. */
function cmp(a: ExportValue, b: ExportValue): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return String(a) < String(b) ? -1 : 1;
}

const SORT_KEYS = ['Version_ID', 'GL_Account_Code', 'GL_Account_ID', 'Month', 'CC1_ID', 'CC2_ID', 'BU_ID'] as const;

function byBudgetKey(x: BudgetsExportRow, y: BudgetsExportRow): number {
  for (const k of SORT_KEYS) {
    const c = cmp(x[k] ?? null, y[k] ?? null);
    if (c !== 0) return c;
  }
  return 0;
}

export function budgetVersionRows(versions: readonly ExportedVersion[]): BudgetsExportRow[] {
  return versions
    .map((v): BudgetsExportRow => ({
      Version_ID: v.id,
      Fiscal_Year: v.fiscalYear,
      Name: v.name,
      Kind: v.kind,
      Status: v.status,
      Is_Primary: v.isPrimary === true,
      Updated_At: v.updatedAt,
      Approved_At: v.approvedAt ?? null,
      Locked_At: v.lockedAt ?? null,
      Schema_Version: BUDGETS_SCHEMA_VERSION,
    }))
    .sort((x, y) => cmp(x.Version_ID ?? null, y.Version_ID ?? null));
}

function row(versionId: string, accountId: string, code: string, month: string,
  dims: { cc1Id: string | null; cc2Id: string | null; buId: string | null }, cents: number, source: string): BudgetsExportRow {
  return {
    Version_ID: versionId, GL_Account_ID: accountId, GL_Account_Code: code, Month: month,
    CC1_ID: dims.cc1Id, CC2_ID: dims.cc2Id, BU_ID: dims.buId, Amount: fromCentsExact(cents), Source: source,
    Schema_Version: BUDGETS_SCHEMA_VERSION,
  };
}

const NO_DIMS = { cc1Id: null, cc2Id: null, buId: null };

/** Every version's rows, the per_head accounts rolled up to company level per month, sorted. */
export function budgetRows(versions: readonly VersionCells[], codeOf: ReadonlyMap<string, string>): BudgetsExportRow[] {
  const code = (accountId: string): string => {
    const c = codeOf.get(accountId);
    if (c === undefined) throw new Error(`budget export: account ${accountId} is not in the company's chart`);
    return c;
  };
  const rows: BudgetsExportRow[] = [];
  for (const v of versions) {
    const rolled = new Map<string, { accountId: string; month: string; cents: number }>();
    for (const c of v.cells) {
      const cents = toCentsExact(c.amount);
      if (!v.perHeadAccountIds.has(c.glAccountId)) {
        rows.push(row(v.versionId, c.glAccountId, code(c.glAccountId), c.month, c, cents, c.source));
        continue;
      }
      const key = `${c.glAccountId}|${c.month}`;
      const sum = rolled.get(key);
      if (sum) sum.cents += cents;
      else rolled.set(key, { accountId: c.glAccountId, month: c.month, cents });
    }
    for (const r of rolled.values()) {
      rows.push(row(v.versionId, r.accountId, code(r.accountId), r.month, NO_DIMS, r.cents, PER_HEAD_ROLLUP_SOURCE));
    }
  }
  return rows.sort(byBudgetKey);
}

export function budgetVersionsSummary(rows: readonly BudgetsExportRow[], asAt: string): BudgetVersionsSummary {
  return { table: 'budget_versions', schemaVersion: BUDGETS_SCHEMA_VERSION, asAt, rowCount: rows.length };
}

export function budgetsSummary(rows: readonly BudgetsExportRow[], asAt: string): BudgetsSummary {
  const cents = rows.reduce((s, r) => s + toCentsExact(r.Amount as number), 0);
  return { table: 'budgets', schemaVersion: BUDGETS_SCHEMA_VERSION, asAt, rowCount: rows.length, controlTotal: fromCentsExact(cents) };
}
