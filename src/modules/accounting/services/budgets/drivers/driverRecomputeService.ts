/**
 * Recompute a version's driver rows (Budgets P4 spec §4, §5) and write ONLY the cells that change.
 * Runs in the caller's transaction, after the caller took the version lock (`takeVersion`, the
 * compare-and-set the grid save and the driver writes share): every driver write and every grid
 * save that changed something calls it once, never per cell.
 *
 * Input (`loadVersionModel`): the version's months from the registry (12, or 14 in a transition
 * year), its rows, cells with their `amount_source`, EVERY driver that can compute (one that
 * cannot is skipped with a warning and its row frozen), and headcount. closedMonths = the months
 * holding an 'actual' cell (a reforecast's closed months): no driver writes or re-sources them.
 *
 * Headcount refreshes on demand only (spec §5: payroll edits never push a recompute): per_head
 * rows are FROZEN (their cells read as they stand) unless the pass names them live: every one on
 * "Refresh headcount" and on a planned-hire write, the row being written on a driver save or reset
 * (the /override route, or an override cleared in the grid). The grid-save hook keeps every other
 * one frozen, so payroll is read only when something live needs it, and then `headcountAsOf` says
 * when: every caller audits it.
 *
 * A changed cell is UPDATEd (amount + the engine's source: 'driver', or 'manual' for a 'driver'
 * cell no driver covers any more), a new one INSERTed as 'driver'; an unchanged cell is not
 * touched, so its updated_at keeps saying when it last changed. Warnings and refusals name
 * accounts by code and name (`labelKeys`), never by row key.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalYear } from '../../gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow, monthKeyToDate } from '../../reports/budgetPeriodWindow';
import { BudgetVersionError } from '../budgetVersionTypes';
import { NIL_UUID } from '../gridSaveValidate';
import { parseKey } from '../grid/cellKey';
import { computeVersion, type DriverWrite } from './driverEngine';
import { DriverRangeError, DriverRefError, type DriverWarningCode, type RowKey } from './driverTypes';
import { BudgetDriverError } from './driverErrors';
import { listDriverLines } from './driverRepository';
import { versionHeadcount } from './driverHeadcount';
import { breakLoops, labelKeys, loadVersionModel } from './driverModel';

/** An engine warning (REF_MISSING, SECTION_EMPTY, BASE_MISSING) or a skipped driver (DRIVER_SKIPPED); labelled. */
export interface RecomputeWarning {
  code: DriverWarningCode | 'DRIVER_SKIPPED';
  rowKey: RowKey;
  message: string;
}

export interface RecomputeResult {
  /** Cells written (updated or inserted). */
  changed: number;
  warnings: RecomputeWarning[];
  /** When payroll was read for a live per_head row (UTC ISO); null when this pass read none. */
  headcountAsOf: string | null;
}

export interface RecomputeOptions {
  /** per_head rows that compute this pass: 'all', or these rows; the rest keep their cells. Default none. */
  live?: 'all' | ReadonlySet<RowKey>;
}

const NIL = NIL_UUID;
const NONE: ReadonlySet<RowKey> = new Set();

/** The months of the version's registry year ('YYYY-MM'). */
export async function versionMonths(companyId: string, fiscalYear: number): Promise<string[]> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) throw new BudgetVersionError('BUDGET_VERSION_STATE', `No financial year is labelled ${fiscalYear}`);
  const months = budgetMonthKeysInWindow(year.startDate, year.endDate);
  if (months.length === 0) throw new BudgetVersionError('BUDGET_VERSION_STATE', `Financial year ${fiscalYear} has no months`);
  return months;
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
 * Recomputes every driver row of the version that can compute and writes the changed cells. The
 * caller holds the version lock. A result beyond the budget range is 400 DRIVER_RANGE (labelled).
 * A stored loop is not fatal: its drivers are left out and their rows frozen, with a labelled
 * DRIVER_SKIPPED warning ("drivers on A → B → A form a loop; change one of them") and a log.warn.
 */
export async function recomputeVersion(
  companyId: string, versionId: string, userId: string, opts: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const lines = await listDriverLines(companyId, versionId);
  // No driver and no 'driver' cell left behind: nothing to compute or re-source (the grid save's
  // usual case, so it reads no cells). A deleted last driver still re-sources its cells 'manual'.
  if (lines.length === 0 && !(await holdsDriverCells(companyId, versionId))) return { changed: 0, warnings: [], headcountAsOf: null };
  const found = (await sql`
    SELECT fiscal_year FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!found[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  const months = await versionMonths(companyId, Number(found[0].fiscal_year));
  // A stored driver whose reference grain has since emptied still computes 0 with REF_MISSING.
  // Strict grain validation belongs to driver saves and reforecast planning, not recomputation.
  const model = await loadVersionModel(companyId, versionId, months, lines, 'recompute');
  const live = opts.live ?? NONE;
  // Only rows of the model may be frozen (the engine refuses an unknown key): a skipped driver on an
  // account retyped out of the income statement has no row at all, so nothing of it is computed anyway.
  const rowKeys = new Set(model.rows.map((r) => r.key));
  const frozen = new Set(model.skipped.map((s) => s.rowKey).filter((k) => rowKeys.has(k)));
  // A stored loop is not fatal: its drivers sit out and their rows keep their cells (breakLoops).
  const { defs, loops } = breakLoops(model);
  for (const loop of loops) {
    for (const key of loop.path) frozen.add(key);
    log.warn('budget driver loop found at recompute: its rows are frozen', { companyId, versionId, path: loop.path.join(' > ') });
  }
  for (const d of defs) if (d.kind === 'per_head' && live !== 'all' && !live.has(d.rowKey)) frozen.add(d.rowKey);
  const readsPayroll = defs.some((d) => d.kind === 'per_head' && !frozen.has(d.rowKey));
  const headcountAsOf = readsPayroll ? new Date().toISOString() : null;
  const heads = readsPayroll ? await versionHeadcount(companyId, versionId, months) : null;
  let result: ReturnType<typeof computeVersion>;
  try {
    result = computeVersion({
      months, rows: model.rows, cells: model.cells, drivers: defs, closedMonths: model.closedMonths,
      frozenRows: frozen, rounding: 1, headcount: (scope, month) => heads?.(scope).get(month)?.total ?? 0,
    });
  } catch (err) {
    if (err instanceof DriverRangeError) throw new BudgetDriverError('DRIVER_RANGE', `A budget driver cannot compute: ${labelKeys(err.message, model.labels)}`);
    if (err instanceof DriverRefError) throw new BudgetDriverError('DRIVER_REF', `A budget driver cannot compute: ${labelKeys(err.message, model.labels)}`);
    throw err;
  }
  const warnings: RecomputeWarning[] = [
    ...model.skipped.map((s) => ({ code: 'DRIVER_SKIPPED' as const, rowKey: s.rowKey, message: s.message })),
    ...loops.map((l) => ({ code: 'DRIVER_SKIPPED' as const, rowKey: l.path[0]!, message: l.message })),
    ...result.warnings.map((w) => ({ ...w, message: labelKeys(w.message, model.labels) })),
  ];
  return { changed: await writeDriverCells(companyId, versionId, userId, result.writes), warnings, headcountAsOf };
}

/**
 * The grid save's hook (P2 `saveCells`, once per batch that changed something): recompute the
 * version's drivers in the save's savepoint, per_head rows frozen except `live` (rows whose
 * override the batch cleared, so their driver value comes back). A result a driver cannot hold
 * refuses the save (400 DRIVER_RANGE) and rolls all of it back.
 */
export async function recomputeDependents(
  companyId: string, versionId: string, userId: string, live: ReadonlySet<RowKey>,
): Promise<RecomputeResult> {
  return recomputeVersion(companyId, versionId, userId, { live });
}
