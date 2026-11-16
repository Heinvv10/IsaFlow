/**
 * Budget write snapshots (migration 999f; Hein's ruling 1, 2026-11-16): the undo record of each amount
 * write an MCP budget tool makes, and the one-step restore of the most recent one.
 *
 * `recordSnapshot` runs in the SAME savepoint as the write it records (the MCP registry's), after the
 * grid save: the before/after value of every changed cell, the version token before and after. Stamps
 * (`created_by`, `restored_by`, times) are the database's (session user, clock), never sent.
 *
 * `planRestore` decides, without writing: only the version's MOST RECENT unrestored snapshot, and only
 * while the version's token still equals that snapshot's `token_after`; otherwise a refusal saying why
 * (the cells that differ now, capped). `restoreSnapshot` writes the before-values back through the grid
 * save (`saveCells`, every rule of a person's save, its audit row as the restoring user) with the
 * snapshot's `token_after` as the compare-and-set token, then marks the snapshot restored. A restore
 * records no snapshot of its own: it cannot itself be undone, and the snapshot before it is then
 * refused (the version's token moved), so restores never chain.
 */
import { sql, type DbRow } from '@/lib/neon';
import { cellKey, type CellKey } from './grid/cellKey';
import { fromCents, toCents } from './grid/cents';
import { saveCells, type SaveCellsResult } from './gridSave';
import { BudgetVersionError } from './budgetVersionTypes';
import type { SaveCell } from './gridSaveValidate';

/** One changed cell: ids (null = no dimension), month 'YYYY-MM', before/after as decimal text (null = no cell). */
export interface SnapshotCell { a: string; c1: string | null; c2: string | null; b: string | null; m: string; before: string | null; after: string | null }

export interface SnapshotRecord {
  versionId: string;
  tool: string;
  tokenJti: string | null;
  tokenBefore: string;
  tokenAfter: string;
  cells: SnapshotCell[];
}

export async function recordSnapshot(companyId: string, s: SnapshotRecord): Promise<string> {
  const rows = (await sql`
    INSERT INTO budget_write_snapshots (company_id, version_id, tool, token_jti, token_before, token_after, cells)
    VALUES (${companyId}::UUID, ${s.versionId}::UUID, ${s.tool}, ${s.tokenJti}, ${s.tokenBefore}, ${s.tokenAfter}, ${JSON.stringify(s.cells)}::JSONB)
    RETURNING id
  `) as DbRow[];
  return String(rows[0]!.id);
}

interface StoredSnapshot { id: string; tool: string; tokenAfter: string; createdAt: string; createdBy: string; cells: SnapshotCell[] }

/** The version's most recent unrestored snapshot, or null. */
async function latestUnrestored(companyId: string, versionId: string): Promise<StoredSnapshot | null> {
  const rows = (await sql`
    SELECT id, tool, token_after, created_by, cells,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM budget_write_snapshots
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID AND restored_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), tool: String(r.tool), tokenAfter: String(r.token_after), createdAt: String(r.created_at),
    createdBy: String(r.created_by), cells: r.cells as SnapshotCell[],
  };
}

const keyOf = (c: SnapshotCell): CellKey => cellKey({ glAccountId: c.a, cc1Id: c.c1, cc2Id: c.c2, buId: c.b, month: c.m });
const centsOf = (v: string | null): number | null => (v === null ? null : toCents(Number(v)));

export type RestorePlan =
  | { ok: true; snapshot: { id: string; tool: string; createdAt: string; createdBy: string }; tokenAfter: string; cells: SaveCell[] }
  | { ok: false; reason: string; differing?: Array<{ cell: SnapshotCell; now: string | null }>; differingCount?: number };

/** At most this many differing cells are named in a refusal. */
export const MAX_DIFFERING_LISTED = 50;

/**
 * The restore of `versionId`'s most recent unrestored snapshot (`snapshotId`, when given, must be it).
 * `current` is the version's token and cells as the caller just read them in ONE statement (the grid
 * read model): cents per cell key.
 */
export async function planRestore(
  companyId: string, versionId: string, snapshotId: string | null, current: { token: string; cents: ReadonlyMap<CellKey, number> },
): Promise<RestorePlan> {
  const latest = await latestUnrestored(companyId, versionId);
  if (!latest) return { ok: false, reason: 'This budget version has no MCP write left to restore' };
  if (snapshotId !== null && latest.id !== snapshotId.toLowerCase()) {
    return { ok: false, reason: `Only the most recent unrestored write of this version can be restored: snapshot ${latest.id} (${latest.tool}, ${latest.createdAt})` };
  }
  if (current.token !== latest.tokenAfter) {
    const differing = latest.cells
      .map((cell) => ({ cell, now: current.cents.get(keyOf(cell)) ?? null }))
      .filter(({ cell, now }) => now !== centsOf(cell.after))
      .map(({ cell, now }) => ({ cell, now: now === null ? null : fromCents(now).toFixed(2) }));
    return {
      ok: false,
      reason: `The budget changed since that write (snapshot ${latest.id}): ${differing.length} of its ${latest.cells.length} cells differ now`
        + `${differing.length === 0 ? ' (the version itself changed: another save, a status move or a driver)' : ''}. Nothing was restored; change the cells by hand instead`,
      differing: differing.slice(0, MAX_DIFFERING_LISTED), differingCount: differing.length,
    };
  }
  const cells: SaveCell[] = latest.cells.map((c) => {
    const ref = { glAccountId: c.a, cc1Id: c.c1, cc2Id: c.c2, buId: c.b, month: c.m };
    return c.before === null ? { ...ref, amount: null, clear: true } : { ...ref, amount: Number(c.before) };
  });
  const { cells: _cells, tokenAfter, ...snapshot } = latest;
  return { ok: true, snapshot, tokenAfter, cells };
}

/** Writes the plan's cells back (the grid save, as `userId`) and marks the snapshot restored. */
export async function restoreSnapshot(
  companyId: string, userId: string, versionId: string, plan: Extract<RestorePlan, { ok: true }>,
): Promise<SaveCellsResult> {
  const result = await saveCells(companyId, userId, { versionId, expectedUpdatedAt: plan.tokenAfter, cells: plan.cells });
  const marked = (await sql`
    UPDATE budget_write_snapshots SET restored_at = now()
     WHERE id = ${plan.snapshot.id}::UUID AND company_id = ${companyId}::UUID AND restored_at IS NULL
    RETURNING id
  `) as DbRow[];
  // The save's compare-and-set on token_after already let one restore through; a second cannot get here.
  if (!marked[0]) throw new BudgetVersionError('BUDGET_VERSION_STALE', 'This write was restored by another request');
  return result;
}
