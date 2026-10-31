/**
 * The budget grid's batch save (Budgets P2, spec §7.2): the only batch writer of a version's
 * amounts. Inside the request transaction it holds the year registry (shared), then takes the
 * version row with a compare-and-set on `updated_at` (the client's token): P1's pre-lock plus
 * the CAS, so two saves of one version serialise and the second, holding a token the first moved,
 * is 409 STALE. Deletes run before upserts, so a grain change in one batch passes decision 4.
 *
 * Everything after the registry lock runs in one savepoint: a refusal raised after the token
 * moved or after a delete (a grain clash, a lock trigger BV001) rolls all of it back, so the 4xx
 * the route answers (which withAuth COMMITs) carries no write and no token bump.
 *
 * Decision 18: a cell is refused on a header (an account another account, active or not, names
 * as its parent) or an inactive account unless that account already holds amounts in the version.
 *
 * Drivers (P4 spec §1.2, §1.3, §5; P4 owns this hook), all inside the savepoint:
 * - a closed month (one where the version holds an 'actual' cell, a reforecast's) is read-only: no
 *   cell there is typed or cleared (an override cleared there would never be refilled): 400;
 * - a 'driver' cell inside its driver's range cannot be cleared (the driver computes it; change or
 *   delete the driver): 400. Clearing an 'override' there IS "reset to driver": the recompute
 *   refills it with the driver's value (`reset` counts them);
 * - a typed cell inside its row's driver range that changes the driver's value (or is new) becomes
 *   'override', which the recompute never touches; typing the value the driver holds changes
 *   nothing (no override, no token bump when nothing else changed);
 * - once per batch that changed something, the version's drivers recompute (`recomputeDependents`,
 *   per_head rows frozen except a row whose override was cleared, a reset that reads payroll and
 *   audits `headcountAsOf`), so rows reading an edited row follow it. The result and the audit row
 *   carry `recomputed` and `driverWarnings` (labelled).
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { isHeaderSql } from './headerSql';
import { getFiscalYear } from '../gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow } from '../reports/budgetPeriodWindow';
import { auditBudgetWrite, holdYearRegistry } from './budgetVersionScope';
import { BudgetVersionError, mapBudgetDbError } from './budgetVersionTypes';
import { inputError } from './gridErrors';
import { takeVersion } from './versionTake';
import {
  cellsTypedOverDrivers, clearedDriverCells, deleteCells, firstClosedMonthCell, markOverrides, versionSum, writeCells,
} from './gridSaveWrite';
import { loadVersionModel, skippedRows } from './drivers/driverModel';
import { listDriverLines } from './drivers/driverRepository';
import { recomputeDependents, type RecomputeWarning } from './drivers/driverRecomputeService';
import { accountWithTwoGrains, assertMonthsInYear, validateBatch, type SaveCell, type ValidatedBatch } from './gridSaveValidate';

export { MAX_IMPORT_CELLS, MAX_SAVE_CELLS, type SaveCell } from './gridSaveValidate';
export { BudgetVersionStaleError } from './versionTake';

export interface SaveCellsInput {
  versionId: string;
  /** The version's updatedAt as the client read it (text, microseconds). */
  expectedUpdatedAt: string;
  cells: SaveCell[];
}

export interface SaveCellsResult {
  /** The version's new token. */
  updatedAt: string;
  saved: number;
  deleted: number;
  /** Cells the version's drivers rewrote after the batch; absent (as are the two below) when the batch changed nothing. */
  recomputed?: number;
  /** Override cells the batch cleared: each reset to its driver's value. */
  reset?: number;
  /** The recompute's warnings (REF_MISSING, SECTION_EMPTY, BASE_MISSING, DRIVER_SKIPPED), as the driver routes answer them. */
  driverWarnings?: RecomputeWarning[];
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Thrown inside the savepoint when the batch changed no row: its rollback takes back the token bump. */
class NothingChanged extends Error {}

/**
 * Ids are compared as text further on (decision 18's "is this one upserted", the duplicate-key
 * check), and Postgres reads them back lower-case, so every id is lower-cased once, here: an
 * upper-case header id slipped past decision 18 and two case variants of a cell past the
 * duplicate check (round-5 M1).
 */
const lowerIds = (c: SaveCell): SaveCell => ({
  ...c, glAccountId: c.glAccountId.toLowerCase(), cc1Id: c.cc1Id?.toLowerCase() ?? null,
  cc2Id: c.cc2Id?.toLowerCase() ?? null, buId: c.buId?.toLowerCase() ?? null,
});

export async function saveCells(companyId: string, userId: string, raw: SaveCellsInput): Promise<SaveCellsResult> {
  const input: SaveCellsInput = { ...raw, versionId: raw.versionId.toLowerCase(), cells: raw.cells.map(lowerIds) };
  const batch = validateBatch(input.cells);
  await holdYearRegistry(companyId);
  try {
    return await withSavepoint('budget_grid_save', () => write(companyId, userId, input, batch));
  } catch (err) {
    // A batch that changes nothing (clears of absent cells, amounts equal to stored) leaves the
    // version as it was: no token bump that would make other users' tokens stale, no audit row.
    // The token answered is the one the compare-and-set verified, not one read after the
    // rollback, which a concurrent writer may already have moved.
    if (err instanceof NothingChanged) return { updatedAt: await isoToken(input.expectedUpdatedAt), saved: 0, deleted: 0 };
    return mapBudgetDbError(err);
  }
}

/** A verified token in P1's form (UTC ISO, microseconds), whichever accepted form the client sent. */
async function isoToken(token: string): Promise<string> {
  const rows = (await sql`
    SELECT to_char(${token}::TIMESTAMPTZ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token
  `) as DbRow[];
  return String(rows[0]?.token);
}

async function write(companyId: string, userId: string, input: SaveCellsInput, batch: ValidatedBatch): Promise<SaveCellsResult> {
  const { versionId } = input;
  const version = await takeVersion(companyId, versionId, input.expectedUpdatedAt);
  const year = await getFiscalYear(companyId, version.fiscalYear);
  if (!year) throw new BudgetVersionError('BUDGET_VERSION_STATE', `No financial year is labelled ${version.fiscalYear}`);
  const months = budgetMonthKeysInWindow(year.startDate, year.endDate);
  assertMonthsInYear(input.cells, months, version.fiscalYear);

  const labels = await checkAccounts(companyId, versionId, input.cells, batch);
  await checkDimensions(companyId, input.cells);
  const twoGrains = accountWithTwoGrains(batch.upserts);
  if (twoGrains) throw grainClash(labels.get(twoGrains)!);
  const cleared = await assertDriverCells(companyId, versionId, batch, labels, months);

  const sumBefore = await versionSum(companyId, versionId);
  const deleted = await deleteCells(companyId, versionId, batch.deletes);
  await assertOneGrain(companyId, versionId, batch.upserts, labels);
  const typedOver = await cellsTypedOverDrivers(companyId, versionId, batch.upserts);
  const changed = await writeCells(companyId, versionId, userId, batch.upserts);
  const overrides = await markOverrides(companyId, versionId, typedOver);
  if (deleted === 0 && changed === 0 && overrides === 0) throw new NothingChanged();
  const { changed: recomputed, warnings, headcountAsOf } = await recomputeDependents(companyId, versionId, userId, cleared.resetRows);
  const sumAfter = await versionSum(companyId, versionId);

  // `saved` and the audit count the rows the batch changed (updated or inserted), not the cells sent.
  await auditBudgetWrite(companyId, userId, 'update', versionId, version.fiscalYear, {
    upserts: String(changed), deletes: String(deleted), sumBefore, sumAfter, versionStatus: version.status,
    overrides: String(overrides), reset: String(cleared.reset), recomputed: String(recomputed),
    driverWarnings: JSON.stringify(warnings), ...(headcountAsOf === null ? {} : { headcountAsOf }),
  });
  return { updatedAt: version.updatedAt, saved: changed, deleted, recomputed, reset: cleared.reset, driverWarnings: warnings };
}

/**
 * The P4 refusals (header, bullets 1-2), raised before any delete or write; returns the overrides
 * the clears reset. A driver skipped this pass (its account retyped out of the income statement,
 * or caught in a stored loop) computes nothing, so its cells are plain figures: clearing one is a clear (P2: a retyped account's
 * stale budget can be cleared), not a refusal or a reset.
 */
async function assertDriverCells(companyId: string, versionId: string, batch: ValidatedBatch, labels: Map<string, string>, months: string[]) {
  const label = (c: SaveCell) => labels.get(c.glAccountId) ?? c.glAccountId;
  const closed = await firstClosedMonthCell(companyId, versionId, [...batch.upserts, ...batch.deletes]);
  if (closed) {
    throw inputError(`Month ${closed.month} is a closed month of this budget (it holds the ledger's actuals): account ${label(closed)} cannot be typed in or cleared there`);
  }
  const touched = await clearedDriverCells(companyId, versionId, batch.deletes);
  if (touched.length === 0) return { reset: 0, resetRows: new Set<string>() };
  // "Skipped" as the recompute decides it (unplaced, out of its months, or in a stored loop): read only when a clear touches a driver row.
  const skipped = skippedRows(await loadVersionModel(
    companyId, versionId, months, await listDriverLines(companyId, versionId), 'recompute',
  ));
  const live = touched.filter((c) => !skipped.has(c.row));
  const computed = live.find((c) => c.source === 'driver');
  if (computed) {
    throw inputError(`Account ${label(computed.cell)} month ${computed.cell.month} is computed by the driver on ${label(computed.cell)}: change or delete the driver`);
  }
  const resets = live.filter((c) => c.source === 'override');
  return { reset: resets.length, resetRows: new Set(resets.map((c) => c.row)) };
}

/**
 * Every account must be the company's. An upserted one must also be a revenue or expense account,
 * and a leaf and active unless it already holds amounts in this version (decision 18); a cleared
 * one need not (an account retyped since can still have its stale budget cleared). Returns each
 * account's "code name" label for messages.
 */
async function checkAccounts(companyId: string, versionId: string, cells: SaveCell[], batch: ValidatedBatch): Promise<Map<string, string>> {
  const ids = unique(cells.map((c) => c.glAccountId));
  const rows = (await sql`
    SELECT t.id::text AS id, ga.account_code, ga.account_name, ga.account_type, ga.is_active, ${isHeaderSql()} AS is_header,
           EXISTS (SELECT 1 FROM budget_month_amounts bm
                    WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID AND bm.gl_account_id = ga.id) AS holds
      FROM unnest(${ids}::UUID[]) AS t(id)
      LEFT JOIN gl_accounts ga ON ga.id = t.id AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];
  const labels = new Map<string, string>();
  const upserted = new Set(batch.upserts.map((u) => u.glAccountId));
  for (const r of rows) {
    const id = String(r.id);
    if (r.account_code === null || r.account_code === undefined) throw inputError(`Account ${id} is not an account of this company`);
    const label = `${String(r.account_code)} ${String(r.account_name ?? '')}`.trim();
    labels.set(id, label);
    // Only a cell WITH an amount must be on a revenue/expense account: a clear may remove the stale
    // budget of an account retyped since.
    if (!upserted.has(id)) continue;
    if (r.account_type !== 'revenue' && r.account_type !== 'expense') {
      throw inputError(`Account ${label} is not a revenue or expense account; budgets are set on revenue and expense accounts only`);
    }
    if (r.holds) continue;
    if (r.is_header) throw inputError(`Account ${label} is a header account: budget its sub-accounts instead`);
    if (!r.is_active) throw inputError(`Account ${label} is inactive: a new budget cannot be set on it`);
  }
  return labels;
}

/** CC1 and CC2 ids must be cost centres of the company of that kind; BU ids its business units. */
async function checkDimensions(companyId: string, cells: SaveCell[]): Promise<void> {
  const centres = unique(cells.flatMap((c) => [c.cc1Id ? `cc1:${c.cc1Id}` : null, c.cc2Id ? `cc2:${c.cc2Id}` : null])
    .filter((x): x is string => x !== null));
  if (centres.length > 0) {
    const bad = (await sql`
      SELECT t.kind, t.id::text AS id
        FROM unnest(${centres.map((x) => x.slice(4))}::UUID[], ${centres.map((x) => x.slice(0, 3))}::TEXT[]) AS t(id, kind)
        LEFT JOIN cost_centres cc ON cc.id = t.id AND cc.company_id = ${companyId}::UUID
       WHERE cc.cc_type IS DISTINCT FROM t.kind
       LIMIT 1
    `) as DbRow[];
    if (bad[0]) throw inputError(`${String(bad[0].kind).toUpperCase()} ${String(bad[0].id)} is not a ${String(bad[0].kind).toUpperCase()} cost centre of this company`);
  }
  const units = unique(cells.map((c) => c.buId).filter((x): x is string => x !== null));
  if (units.length > 0) {
    const bad = (await sql`
      SELECT t.id::text AS id FROM unnest(${units}::UUID[]) AS t(id)
       WHERE NOT EXISTS (SELECT 1 FROM business_units b WHERE b.id = t.id AND b.company_id = ${companyId}::UUID)
       LIMIT 1
    `) as DbRow[];
    if (bad[0]) throw inputError(`Business unit ${String(bad[0].id)} is not a business unit of this company`);
  }
}

const grainClash = (label: string) => new BudgetVersionError('BUDGET_GRAIN_CONFLICT',
  `Account ${label} is budgeted at one level per version (company level or one dimension): clear its other cells in the same save to change its level`);

/**
 * After the deletes: an upserted account that still has cells at another grain in the version is
 * a typed 400 naming it (the exclusion constraint stays as the backstop, mapped the same way).
 */
async function assertOneGrain(
  companyId: string, versionId: string, upserts: ValidatedBatch['upserts'], labels: Map<string, string>,
): Promise<void> {
  if (upserts.length === 0) return;
  const grainOf = new Map(upserts.map((u) => [u.glAccountId, u.grain]));
  const clash = (await sql`
    SELECT bm.gl_account_id::text AS id FROM budget_month_amounts bm
      JOIN unnest(${[...grainOf.keys()]}::UUID[], ${[...grainOf.values()]}::SMALLINT[]) AS t(a, g) ON bm.gl_account_id = t.a
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID AND bm.dim_grain <> t.g
     LIMIT 1
  `) as DbRow[];
  if (clash[0]) throw grainClash(labels.get(String(clash[0].id)) ?? String(clash[0].id));
}
