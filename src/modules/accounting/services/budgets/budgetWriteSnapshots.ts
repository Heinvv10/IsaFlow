/**
 * Budget write snapshots (migration 999l; Hein's ruling 1, 2026-11-16): the undo record of each amount
 * write an MCP budget tool makes. `recordSnapshot` runs in the SAME savepoint as the write it records (the
 * MCP registry's), after the grid save: every cell the write changed (the cells it was asked to write, not
 * a driver's recomputed dependents, which recompute again on a restore), its value and amount_source
 * before and after as the database holds them, and the version token before and after. Stamps
 * (`created_by`, `restored_by`, times) are the database's (session user, clock), never sent. The restore
 * is budgetSnapshotRestore.ts.
 */
import { sql, type DbRow } from '@/lib/neon';
import { cellKey, type CellKey } from './grid/cellKey';
import { BudgetVersionError } from './budgetVersionTypes';

/**
 * One changed cell: ids (null = no dimension), month 'YYYY-MM', before/after as decimal text (null = no
 * cell), and the cell's amount_source before (`bs`) and after (`as`), null where there was no cell.
 */
export interface SnapshotCell {
  a: string; c1: string | null; c2: string | null; b: string | null; m: string;
  before: string | null; after: string | null; bs: string | null; as: string | null;
}

export interface SnapshotRecord {
  versionId: string;
  tool: string;
  tokenJti: string | null;
  tokenBefore: string;
  tokenAfter: string;
  cells: SnapshotCell[];
}

/**
 * The tool name a set_budget_drivers snapshot records (PR 3): a record of the cells a driver write changed
 * (recomputed dependents included), never restored (budgetSnapshotRestore refuses it: driver lines, planned
 * hires and overrides cannot be put back exactly).
 */
export const DRIVER_WRITE_TOOL = 'set_budget_drivers';

export const snapshotKey = (c: SnapshotCell): CellKey => cellKey({ glAccountId: c.a, cc1Id: c.c1, cc2Id: c.c2, buId: c.b, month: c.m });

export async function recordSnapshot(companyId: string, s: SnapshotRecord): Promise<string> {
  const rows = (await sql`
    INSERT INTO budget_write_snapshots (company_id, version_id, tool, token_jti, token_before, token_after, cells)
    VALUES (${companyId}::UUID, ${s.versionId}::UUID, ${s.tool}, ${s.tokenJti}, ${s.tokenBefore}, ${s.tokenAfter}, ${JSON.stringify(s.cells)}::JSONB)
    RETURNING id
  `) as DbRow[];
  return String(rows[0]!.id);
}

export interface StoredSnapshot {
  id: string; tool: string; tokenAfter: string; createdAt: string; createdBy: string; restored: boolean; cells: SnapshotCell[];
}

/** The version's most recent snapshot, restored or not (the restore's "nothing changed since" anchor), or null. */
export async function latestSnapshot(companyId: string, versionId: string): Promise<StoredSnapshot | null> {
  const rows = (await sql`
    SELECT id, tool, token_after, created_by, cells, restored_at IS NOT NULL AS restored,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM budget_write_snapshots
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), tool: String(r.tool), tokenAfter: String(r.token_after), createdAt: String(r.created_at),
    createdBy: String(r.created_by), restored: r.restored === true, cells: r.cells as SnapshotCell[],
  };
}

/** Marks the snapshot restored (the database stamps who and when); a snapshot already restored is a 409. */
export async function markRestored(companyId: string, snapshotId: string): Promise<void> {
  const marked = (await sql`
    UPDATE budget_write_snapshots SET restored_at = now()
     WHERE id = ${snapshotId}::UUID AND company_id = ${companyId}::UUID AND restored_at IS NULL
    RETURNING id
  `) as DbRow[];
  if (!marked[0]) throw new BudgetVersionError('BUDGET_VERSION_STALE', 'This write was restored by another request');
}
