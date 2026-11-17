/**
 * The one-step restore of an MCP budget write (Hein's ruling 1; review round 1, 2026-11-16).
 *
 * `planRestore` decides without writing. It restores only the version's MOST RECENT snapshot, and only when
 *  - that snapshot is not restored yet (a later write, restored or not, means the version changed since an
 *    earlier one: restores never chain);
 *  - the caller made the write, or is an owner or admin;
 *  - the version's token still equals the snapshot's `token_after`, AND every cell of the snapshot still
 *    holds its after-value and amount_source. The content check is what holds inside one transaction (an
 *    MCP batch), where every budget write sets the token to the same now().
 * Otherwise it refuses saying why (the cells that differ now, capped). A plan carries `planHash`
 * (budgetPlanHash) so a live restore applies exactly the plan its dry run showed.
 *
 * PR 3: restore undoes AMOUNT writes only. A set_budget_drivers snapshot is refused, and so is an amount write once the
 * version's drivers changed at or after its transaction (`driverChangesSince`, the drivers' own audit rows).
 *
 * `restoreSnapshot` writes the before-values back through the grid save (`saveCells`: every rule of a
 * person's save, its audit row as the restoring user), a cell that was a driver's computed value before as
 * a clear (the driver recomputes it), then checks every cell holds its before-value again, and a former override
 * that a driver still covers holds 'override' again (one outside every driver's range comes back 'manual', as the
 * grid writes it); it throws, rolled back, when the save could not put one back exactly, and marks the snapshot restored.
 */
import { cellKey, type CellKey } from './grid/cellKey';
import { fromCents, toCents } from './grid/cents';
import { saveCells, type SaveCellsResult } from './gridSave';
import type { SaveCell } from './gridSaveValidate';
import { loadGridCells } from './gridReadModel';
import { BudgetVersionError } from './budgetVersionTypes';
import { budgetPlanHash } from './budgetPlanHash';
import { listDriverLines } from './drivers/driverRepository';
import { DRIVER_WRITE_TOOL, latestSnapshot, markRestored, snapshotKey, type SnapshotCell } from './budgetWriteSnapshots';
import { driverChangesSince } from './budgetVersionActivity';

export interface CellState { cents: number; source: string }
export interface CurrentState {
  token: string;
  cells: ReadonlyMap<CellKey, CellState>;
  /**
   * When the version's status last moved: the latest of its approved / locked / unlocked stamps (clock time,
   * P1's text form), or null. A status move after the write refuses the restore; inside one transaction the
   * token cannot show it (every write sets updated_at to the same now()), the clock stamps can.
   */
  statusMovedAt: string | null;
}
export interface RestoreActor { userId: string; role: string | null | undefined }

export type RestorePlan =
  | { ok: true; snapshot: { id: string; tool: string; createdAt: string; createdBy: string }; token: string; cells: SaveCell[]; snapshotCells: SnapshotCell[]; planHash: string }
  | { ok: false; reason: string; differing?: Array<{ cell: SnapshotCell; now: string | null; nowSource: string | null }>; differingCount?: number };

/** At most this many differing cells are named in a refusal. */
const MAX_DIFFERING_LISTED = 50;

const RESTORERS = new Set(['owner', 'admin']);
const centsOf = (v: string | null): number | null => (v === null ? null : toCents(Number(v)));

function holdsAfter(cell: SnapshotCell, now: CellState | undefined): boolean {
  if (cell.after === null) return now === undefined;
  return now !== undefined && now.cents === centsOf(cell.after) && (cell.as === null || now.source === cell.as);
}

function restoreCell(c: SnapshotCell): SaveCell {
  const ref = { glAccountId: c.a, cc1Id: c.c1, cc2Id: c.c2, buId: c.b, month: c.m };
  // No cell before, or the driver's own computed value before: a clear (a cleared override resets to its driver).
  return c.before === null || c.bs === 'driver' ? { ...ref, amount: null, clear: true } : { ...ref, amount: Number(c.before) };
}

export async function planRestore(
  companyId: string, versionId: string, snapshotId: string | null, current: CurrentState, actor: RestoreActor,
): Promise<RestorePlan> {
  const latest = await latestSnapshot(companyId, versionId);
  if (!latest) return { ok: false, reason: 'This budget version has no MCP write to restore' };
  if (snapshotId !== null && latest.id !== snapshotId.toLowerCase()) {
    return { ok: false, reason: `Only the most recent MCP write of this version can be restored: snapshot ${latest.id} (${latest.tool}, ${latest.createdAt})` };
  }
  if (latest.restored) {
    return { ok: false, reason: `The most recent MCP write of this version (snapshot ${latest.id}) is already restored; an earlier write cannot be restored, the version changed since it` };
  }
  if (latest.createdBy !== actor.userId && !RESTORERS.has(actor.role ?? '')) {
    return { ok: false, reason: 'Only the person whose connection made that write, or an owner or admin, can restore it' };
  }
  // PR 3: restore undoes AMOUNT writes. A driver write's snapshot records the cells it changed, but its driver
  // lines, planned hires and overrides cannot be put back exactly, so it is refused rather than half-undone.
  if (latest.tool === DRIVER_WRITE_TOOL) {
    return {
      ok: false,
      reason: `The most recent MCP write of this version (snapshot ${latest.id}) was set_budget_drivers: restore_budget_version undoes amount writes only `
        + '(set_budget_amounts, set_budget_annual), never driver lines, planned hires, overrides or a headcount refresh. Nothing was restored; '
        + 'set the drivers back with set_budget_drivers (its reply listed each driver line and planned hire as it was before)',
    };
  }
  if (await driverChangesSince(companyId, versionId, latest.tokenAfter) > 0) {
    return {
      ok: false,
      reason: `The drivers of this version changed since that write (snapshot ${latest.id}): a driver line, planned hire, override reset or headcount `
        + 'refresh, in the same request as the write or later. Restoring its cells would recompute them under other drivers, so nothing was restored; change the cells by hand instead',
    };
  }
  if (current.statusMovedAt !== null && current.statusMovedAt > latest.createdAt) {
    return { ok: false, reason: `The version's status changed since that write (snapshot ${latest.id}: approved, locked or unlocked after it). Nothing was restored; change the cells by hand instead` };
  }
  const differing = latest.cells
    .filter((cell) => !holdsAfter(cell, current.cells.get(snapshotKey(cell))))
    .map((cell) => {
      const now = current.cells.get(snapshotKey(cell));
      return { cell, now: now ? fromCents(now.cents).toFixed(2) : null, nowSource: now?.source ?? null };
    });
  if (current.token !== latest.tokenAfter || differing.length > 0) {
    return {
      ok: false,
      reason: `The budget changed since that write (snapshot ${latest.id}): ${differing.length} of its ${latest.cells.length} cells differ now`
        + `${differing.length === 0 ? ' (the version itself changed: another save, a status move or a driver)' : ''}. Nothing was restored; change the cells by hand instead`,
      differing: differing.slice(0, MAX_DIFFERING_LISTED), differingCount: differing.length,
    };
  }
  // The save never pins an override at the value its driver computes (typing the driver's value changes nothing), so
  // an override the write reset to an equal driver value cannot be put back exactly: refused, never left half-done.
  const unpinnable = latest.cells.find((c) => c.bs === 'override' && c.as === 'driver' && centsOf(c.before) === centsOf(c.after));
  if (unpinnable) {
    return {
      ok: false,
      reason: `Account ${unpinnable.a} month ${unpinnable.m} was a manual override of ${unpinnable.before}, and its driver now computes the same value: `
        + 'the grid save cannot pin that override again, so the write cannot be restored exactly. Nothing was restored; retype the cell over its driver in IsaFlow if it must stay pinned',
    };
  }
  const cells = latest.cells.map(restoreCell);
  const planHash = budgetPlanHash(versionId, `restore:${latest.id}`, current.token, latest.cells.map((c) => {
    const now = current.cells.get(snapshotKey(c));
    return { key: snapshotKey(c), before: now?.cents ?? null, beforeSource: now?.source ?? null, after: centsOf(c.before) };
  }));
  const { id, tool, createdAt, createdBy } = latest;
  return { ok: true, snapshot: { id, tool, createdAt, createdBy }, token: current.token, cells, snapshotCells: latest.cells, planHash };
}

/** Writes the plan back (the grid save, as `userId`), checks every cell holds its before-value, marks the snapshot restored. */
export async function restoreSnapshot(
  companyId: string, userId: string, versionId: string, plan: Extract<RestorePlan, { ok: true }>,
): Promise<SaveCellsResult> {
  const result = await saveCells(companyId, userId, { versionId, expectedUpdatedAt: plan.token, cells: plan.cells });
  const after = await loadGridCells(companyId, { versionId }, userId);
  const now = new Map(after.cells.map((c) => [cellKey(c), c]));
  // An override comes back as an override only where a driver covers the cell NOW; one left outside its driver's
  // range (a driver save that shrank the range keeps it) is a manual figure once rewritten, as in the grid.
  const lines = await listDriverLines(companyId, versionId);
  const covered = (c: SnapshotCell) => lines.some((d) => d.glAccountId === c.a && d.cc1Id === c.c1 && d.cc2Id === c.c2 && d.buId === c.b
    && d.fromMonth <= c.m && c.m <= d.toMonth);
  const off = plan.snapshotCells.find((c) => {
    const cell = now.get(snapshotKey(c));
    if (c.before === null) return cell !== undefined;
    return cell === undefined || toCents(cell.amount) !== centsOf(c.before)
      || (c.bs === 'driver' && cell.source !== 'driver') || (c.bs === 'override' && covered(c) && cell.source !== 'override');
  });
  if (off) {
    throw new BudgetVersionError('BUDGET_VERSION_STATE',
      `The restore could not put account ${off.a} month ${off.m} back exactly (its value or its driver / override source); nothing was restored`);
  }
  await markRestored(companyId, plan.snapshot.id);
  return result;
}
