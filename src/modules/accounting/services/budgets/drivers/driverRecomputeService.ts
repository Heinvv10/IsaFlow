/**
 * Recompute a version's driver rows (Budgets P4 spec §4, §5) and write ONLY the cells that change.
 * Runs in the caller's transaction, after the caller took the version lock (`takeVersion`, the
 * compare-and-set the grid save and the driver writes share): every driver write and every grid save that changed
 * something calls it once, never per cell.
 *
 * Input: the version's months from the registry (12, or 14 in a transition year), a row for every
 * account + grain holding cells in the version or named by a driver (its own row or the row it
 * reads), banded by account type and subtype (`bandOf`, the grid's sections), every cell with its
 * `amount_source`, the drivers, and headcount (payroll actives + the version's planned hires, each
 * scope computed once). closedMonths is empty: only reforecasts hold 'actual' cells, and the engine
 * never writes those. A changed cell is UPDATEd (amount + the engine's source: 'driver', or 'manual'
 * for a 'driver' cell no driver covers any more), a new one INSERTed as 'driver'; an
 * unchanged cell is not touched, so its updated_at keeps saying when it last changed.
 *
 * Cells on an account that is not revenue or expense are not rows (the grid does not show them);
 * a driver naming one is a DriverRefError, a 400 at driver save and in the grid save hook.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalYear } from '../../gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow, monthKeyToDate } from '../../reports/budgetPeriodWindow';
import { BudgetVersionError } from '../budgetVersionTypes';
import { inputError } from '../gridErrors';
import { NIL_UUID } from '../gridSaveValidate';
import { parseKey } from '../grid/cellKey';
import { toCents } from '../grid/cents';
import { bandOf } from '../grid/subtotals';
import { computeVersion, type DriverWrite } from './driverEngine';
import {
  DriverCycleError, DriverRangeError, DriverRefError, rowKeyFor,
  type Cell, type CellSource, type DriverDef, type DriverRow, type DriverWarning, type RowKey,
} from './driverTypes';
import { rowKeyOfGrain, toDriverDef, type DriverGrain, type DriverLine } from './driverLine';
import { listDriverLines } from './driverRepository';
import { versionHeadcount } from './driverHeadcount';

export interface RecomputeResult {
  /** Cells written (updated or inserted). */
  changed: number;
  warnings: DriverWarning[];
}

export interface VersionModel {
  months: string[];
  rows: DriverRow[];
  cells: Map<RowKey, Cell[]>;
  defs: DriverDef[];
  /** Account id → "code name", for messages. */
  labels: Map<string, string>;
}

const NIL = NIL_UUID;
const id = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The months of the version's registry year ('YYYY-MM'). */
export async function versionMonths(companyId: string, fiscalYear: number): Promise<string[]> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) throw new BudgetVersionError('BUDGET_VERSION_STATE', `No financial year is labelled ${fiscalYear}`);
  const months = budgetMonthKeysInWindow(year.startDate, year.endDate);
  if (months.length === 0) throw new BudgetVersionError('BUDGET_VERSION_STATE', `Financial year ${fiscalYear} has no months`);
  return months;
}

/** The engine's view of the version with `lines` as its drivers (a driver save passes the candidate set). */
export async function loadVersionModel(
  companyId: string, versionId: string, months: string[], lines: readonly DriverLine[],
): Promise<VersionModel> {
  const cellRows = (await sql`
    SELECT gl_account_id::text AS a, cc1_id::text AS c1, cc2_id::text AS c2, bu_id::text AS b, to_char(month, 'YYYY-MM') AS m,
           amount::text AS amount, amount_source
      FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
       AND month BETWEEN ${monthKeyToDate(months[0]!)}::DATE AND ${monthKeyToDate(months[months.length - 1]!)}::DATE
  `) as DbRow[];
  const grains = new Map<RowKey, DriverGrain>();
  const cellsOf = new Map<RowKey, Cell[]>();
  for (const r of cellRows) {
    const g = { glAccountId: String(r.a), cc1Id: id(r.c1), cc2Id: id(r.c2), buId: id(r.b) };
    const key = rowKeyFor(g);
    grains.set(key, g);
    const list = cellsOf.get(key) ?? [];
    list.push({ month: String(r.m), amount: toCents(Number(r.amount)), source: String(r.amount_source) as CellSource });
    cellsOf.set(key, list);
  }
  for (const line of lines) {
    grains.set(rowKeyOfGrain(line), line);
    if (line.ref) grains.set(rowKeyOfGrain(line.ref), line.ref);
  }

  const accountIds = [...new Set([...grains.values()].map((g) => g.glAccountId))];
  const accounts = (await sql`
    SELECT id::text AS id, account_code, account_name, account_type, account_subtype FROM gl_accounts
     WHERE company_id = ${companyId}::UUID AND id = ANY(${accountIds}::UUID[])
  `) as DbRow[];
  const byId = new Map(accounts.map((a) => [String(a.id), a]));
  const labels = new Map(accounts.map((a) => [String(a.id), `${String(a.account_code)} ${String(a.account_name ?? '')}`.trim()]));

  const rows: DriverRow[] = [];
  const cells = new Map<RowKey, Cell[]>();
  for (const [key, g] of grains) {
    const a = byId.get(g.glAccountId);
    if (!a || (a.account_type !== 'revenue' && a.account_type !== 'expense')) continue;
    rows.push({ key, ...g, band: bandOf(a.account_type, a.account_subtype === null ? null : String(a.account_subtype)) });
    const own = cellsOf.get(key);
    if (own) cells.set(key, own);
  }
  return { months, rows, cells, defs: lines.map(toDriverDef), labels };
}

/** Writes the engine's changed cells with their source. Never an 'override' or 'actual' cell (the engine skips them; the UPDATE refuses them too). */
async function writeDriverCells(companyId: string, versionId: string, userId: string, writes: readonly DriverWrite[]): Promise<number> {
  if (writes.length === 0) return 0;
  const refs = writes.map((w) => parseKey(`${w.rowKey}|${w.month}`));
  const a = refs.map((r) => r.glAccountId);
  const c1 = refs.map((r) => r.cc1Id ?? NIL);
  const c2 = refs.map((r) => r.cc2Id ?? NIL);
  const b = refs.map((r) => r.buId ?? NIL);
  const m = refs.map((r) => monthKeyToDate(r.month));
  const cents = writes.map((w) => w.amount);
  const src = writes.map((w) => w.source);
  const updated = (await sql`
    WITH up AS (
    UPDATE budget_month_amounts bm SET amount = t.cents::NUMERIC / 100, amount_source = t.src
      FROM unnest(${a}::UUID[], ${c1}::UUID[], ${c2}::UUID[], ${b}::UUID[], ${m}::DATE[], ${cents}::BIGINT[], ${src}::TEXT[])
           AS t(a, c1, c2, b, m, cents, src)
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
       AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
       AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b
       AND bm.amount_source NOT IN ('override', 'actual')
    RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM up
  `) as DbRow[];
  const inserted = (await sql`
    WITH ins AS (
    INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, amount_source, created_by)
    SELECT ${companyId}::UUID, ${versionId}::UUID, t.a, NULLIF(t.c1, ${NIL}::UUID), NULLIF(t.c2, ${NIL}::UUID),
           NULLIF(t.b, ${NIL}::UUID), t.m, t.cents::NUMERIC / 100, 'driver', ${userId}
      FROM unnest(${a}::UUID[], ${c1}::UUID[], ${c2}::UUID[], ${b}::UUID[], ${m}::DATE[], ${cents}::BIGINT[], ${src}::TEXT[])
           AS t(a, c1, c2, b, m, cents, src)
     WHERE t.src = 'driver' AND NOT EXISTS (
       SELECT 1 FROM budget_month_amounts bm
        WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
          AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
          AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b)
    RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `) as DbRow[];
  return Number(updated[0]?.n ?? 0) + Number(inserted[0]?.n ?? 0);
}

async function holdsDriverCells(companyId: string, versionId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (SELECT 1 FROM budget_month_amounts WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
                      AND amount_source = 'driver') AS held
  `) as DbRow[];
  return Boolean(rows[0]?.held);
}

/**
 * Recomputes every driver row of the version and writes the changed cells. The caller holds the
 * version lock. A cycle here means a stored graph the save-time check should have refused: an
 * invariant break, so a 500 (logged), not a 400.
 */
export async function recomputeVersion(companyId: string, versionId: string, userId: string): Promise<RecomputeResult> {
  const lines = await listDriverLines(companyId, versionId);
  // No driver and no 'driver' cell left behind: nothing to compute or re-source (the grid save's
  // usual case, so it reads no cells). A deleted last driver still re-sources its cells 'manual'.
  if (lines.length === 0 && !(await holdsDriverCells(companyId, versionId))) return { changed: 0, warnings: [] };
  const found = (await sql`
    SELECT fiscal_year FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!found[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  const months = await versionMonths(companyId, Number(found[0].fiscal_year));
  const model = await loadVersionModel(companyId, versionId, months, lines);
  const heads = model.defs.some((d) => d.kind === 'per_head') ? await versionHeadcount(companyId, versionId, months) : null;
  let result: ReturnType<typeof computeVersion>;
  try {
    result = computeVersion({
      months, rows: model.rows, cells: model.cells, drivers: model.defs, closedMonths: new Set(), rounding: 1,
      headcount: (scope, month) => heads?.(scope).get(month)?.total ?? 0,
    });
  } catch (err) {
    if (!(err instanceof DriverCycleError)) throw err;
    log.error('budget driver cycle found at recompute', { companyId, versionId, path: err.path.join(' > ') });
    throw new Error(`Budget version ${versionId} holds a driver cycle`);
  }
  return { changed: await writeDriverCells(companyId, versionId, userId, result.writes), warnings: result.warnings };
}

/**
 * The grid save's hook (P2 `saveCells`, once per batch that changed something): recompute the
 * version's drivers in the save's savepoint. A result a driver cannot hold (beyond NUMERIC(15,2)),
 * or a driver the version can no longer place, refuses the save (400) and rolls all of it back.
 */
export async function recomputeDependents(companyId: string, versionId: string, userId: string): Promise<number> {
  try {
    return (await recomputeVersion(companyId, versionId, userId)).changed;
  } catch (err) {
    if (err instanceof DriverRangeError || err instanceof DriverRefError) {
      throw inputError(`This change leaves a budget driver unable to compute: ${err.message}`);
    }
    throw err;
  }
}
