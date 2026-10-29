/**
 * The grid save's writes (Budgets P2 spec §7.2), run by gridSave.ts with the version locked.
 *
 * Shaped for the time the version is held (round-2 Q2; numbers in gridSaveValidate.ts next to
 * MAX_SAVE_CELLS). A cell is matched on its full key with the dimensions COALESCEd to a nil UUID,
 * so Postgres can hash-join the batch against the version: `IS NOT DISTINCT FROM` cannot be
 * hashed, and the merge join it fell back to compared every member of an account-month with every
 * other (333 M row pairs for a 200 000-cell delete, 27 s). An existing cell is UPDATEd on its
 * amount alone, which fires only the lock and updated_at triggers (the dimension-kind and
 * same-company triggers watch other columns); `INSERT … ON CONFLICT DO UPDATE` ran every BEFORE
 * INSERT trigger first and the lock trigger twice. A cell whose amount does not change is not
 * touched, so its updated_at keeps saying when it last changed. Only new cells are INSERTed.
 *
 * P4 (drivers): typing in or clearing a closed month, clearing a driver-computed cell are refused;
 * clearing an override is a reset; a typed cell that changes a driver's value is marked 'override'.
 */
import { sql, type DbRow } from '@/lib/neon';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { toCents } from './grid/cents';
import { NIL_UUID, type SaveCell, type ValidatedBatch } from './gridSaveValidate';

/** Stands in for "no dimension" in the match keys only; never written, and refused as an id by validateBatch. */
const NIL = NIL_UUID;

const keyArrays = (cells: readonly SaveCell[]) => ({
  a: cells.map((c) => c.glAccountId), c1: cells.map((c) => c.cc1Id ?? NIL), c2: cells.map((c) => c.cc2Id ?? NIL),
  b: cells.map((c) => c.buId ?? NIL), m: cells.map((c) => monthKeyToDate(c.month)),
});

/** The version's amount total, for the audit row. */
export async function versionSum(companyId: string, versionId: string): Promise<string> {
  const rows = (await sql`
    SELECT COALESCE(SUM(amount), 0.00)::text AS s FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
  `) as DbRow[];
  return String(rows[0]?.s ?? '0.00');
}

/** Deletes the cells; returns how many existed. */
export async function deleteCells(companyId: string, versionId: string, cells: readonly SaveCell[]): Promise<number> {
  if (cells.length === 0) return 0;
  const k = keyArrays(cells);
  const rows = (await sql`
    WITH gone AS (
      DELETE FROM budget_month_amounts bm
       USING unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[]) AS t(a, c1, c2, b, m)
       WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
         AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
         AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM gone
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}

/** Sets each cell's amount: an existing cell is updated (when it changes), a new one inserted. Returns the rows changed. */
export async function writeCells(companyId: string, versionId: string, userId: string, cells: ValidatedBatch['upserts']): Promise<number> {
  if (cells.length === 0) return 0;
  const k = keyArrays(cells);
  // Whole cents travel as integers and are divided in NUMERIC, so no float reaches the column.
  const cents = cells.map((c) => toCents(c.amount));
  const updated = (await sql`
    WITH up AS (
    UPDATE budget_month_amounts bm SET amount = t.cents::NUMERIC / 100
      FROM unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[], ${cents}::BIGINT[])
           AS t(a, c1, c2, b, m, cents)
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
       AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
       AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b
       AND bm.amount <> t.cents::NUMERIC / 100
    RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM up
  `) as DbRow[];
  // The version row is locked, so no other writer adds one of these cells in between; the
  // conflict clause stays as the backstop.
  const inserted = (await sql`
    WITH ins AS (
    INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, created_by)
    SELECT ${companyId}::UUID, ${versionId}::UUID, t.a, NULLIF(t.c1, ${NIL}::UUID), NULLIF(t.c2, ${NIL}::UUID),
           NULLIF(t.b, ${NIL}::UUID), t.m, t.cents::NUMERIC / 100, ${userId}
      FROM unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[], ${cents}::BIGINT[])
           AS t(a, c1, c2, b, m, cents)
     WHERE NOT EXISTS (
       SELECT 1 FROM budget_month_amounts bm
        WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
          AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
          AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b)
    ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell
    DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()
    RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `) as DbRow[];
  return Number(updated[0]?.n ?? 0) + Number(inserted[0]?.n ?? 0);
}

/** The match of a version cell `bm` to the batch row `t` (dimensions COALESCEd, hashable). */
const cellMatch = (companyId: string, versionId: string) => sql`
  bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
  AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
  AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b`;

/** The driver line `d` covering the batch row `t`'s row and month. */
const driverCovers = (companyId: string, versionId: string) => sql`
  d.company_id = ${companyId}::UUID AND d.version_id = ${versionId}::UUID AND d.gl_account_id = t.a
  AND COALESCE(d.cc1_id, ${NIL}::UUID) = t.c1 AND COALESCE(d.cc2_id, ${NIL}::UUID) = t.c2
  AND COALESCE(d.bu_id, ${NIL}::UUID) = t.b AND t.m BETWEEN d.from_month AND d.to_month`;

/**
 * The first cell of the batch (typed or cleared) in a CLOSED month: one in which the version holds
 * an 'actual' cell (a reforecast's closed months hold the ledger's figures; the next roll refreshes
 * them). Closed months are read-only: typing over an actual or into a new cell, and clearing any
 * cell there (an override would be deleted and never refilled: no driver writes a closed month).
 */
export async function firstClosedMonthCell(companyId: string, versionId: string, cells: readonly SaveCell[]): Promise<SaveCell | null> {
  if (cells.length === 0) return null;
  const rows = (await sql`
    SELECT DISTINCT to_char(month, 'YYYY-MM') AS m FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID AND amount_source = 'actual'
  `) as DbRow[];
  const closed = new Set(rows.map((r) => String(r.m)));
  return cells.find((c) => closed.has(c.month)) ?? null;
}

export interface ClearedSources {
  /** A cleared 'driver' cell inside its driver's range (refused: the driver computes it). */
  computed: SaveCell | null;
  /** Cleared 'override' cells inside their driver's range: a reset to driver, refilled by the recompute. */
  overrides: number;
  /** The rows of those overrides (`acct|cc1|cc2|bu`). */
  overrideRows: Set<string>;
}

/** What the batch's clears (outside closed months) would remove that is not a plain typed figure. */
export async function classifyClears(companyId: string, versionId: string, cells: readonly SaveCell[]): Promise<ClearedSources> {
  const out: ClearedSources = { computed: null, overrides: 0, overrideRows: new Set() };
  if (cells.length === 0) return out;
  const k = keyArrays(cells);
  const rows = (await sql`
    SELECT t.a::text AS a, NULLIF(t.c1, ${NIL}::UUID)::text AS c1, NULLIF(t.c2, ${NIL}::UUID)::text AS c2,
           NULLIF(t.b, ${NIL}::UUID)::text AS b, to_char(t.m, 'YYYY-MM') AS m, bm.amount_source AS src,
           EXISTS (SELECT 1 FROM budget_driver_lines d WHERE ${driverCovers(companyId, versionId)}) AS covered
      FROM unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[]) AS t(a, c1, c2, b, m)
      JOIN budget_month_amounts bm ON ${cellMatch(companyId, versionId)}
     WHERE bm.amount_source IN ('driver', 'override')
     ORDER BY 1, 5
  `) as DbRow[];
  const find = (r: DbRow) => cells.find((c) => c.glAccountId === String(r.a) && c.month === String(r.m)) ?? null;
  for (const r of rows) {
    if (r.src === 'driver' && r.covered) out.computed ??= find(r);
    else if (r.src === 'override' && r.covered) {
      out.overrides += 1;
      out.overrideRows.add([r.a, r.c1 ?? '', r.c2 ?? '', r.b ?? ''].join('|'));
    }
  }
  return out;
}

/**
 * The upserted cells that type over a driver: inside their row's driver range, and either new or
 * holding a different amount (a value equal to the driver's stays the driver's: no override, and
 * no write). Read BEFORE `writeCells`; `markOverrides` marks them after it.
 */
export async function cellsTypedOverDrivers(companyId: string, versionId: string, cells: ValidatedBatch['upserts']): Promise<ValidatedBatch['upserts']> {
  if (cells.length === 0) return [];
  const k = keyArrays(cells);
  const cents = cells.map((c) => toCents(c.amount));
  const rows = (await sql`
    SELECT t.i FROM unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[], ${cents}::BIGINT[],
                           ${cells.map((_, i) => i)}::INT[]) AS t(a, c1, c2, b, m, cents, i)
     WHERE EXISTS (SELECT 1 FROM budget_driver_lines d WHERE ${driverCovers(companyId, versionId)})
       AND NOT EXISTS (SELECT 1 FROM budget_month_amounts bm WHERE ${cellMatch(companyId, versionId)}
                          AND (bm.amount_source = 'override' OR bm.amount = t.cents::NUMERIC / 100))
  `) as DbRow[];
  return rows.map((r) => cells[Number(r.i)]!);
}

/** Marks the typed-over cells 'override' (P4 spec §1.2: the recompute never touches one). Returns how many. */
export async function markOverrides(companyId: string, versionId: string, cells: ValidatedBatch['upserts']): Promise<number> {
  if (cells.length === 0) return 0;
  const k = keyArrays(cells);
  const rows = (await sql`
    WITH marked AS (
    UPDATE budget_month_amounts bm SET amount_source = 'override'
      FROM unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[]) AS t(a, c1, c2, b, m)
     WHERE ${cellMatch(companyId, versionId)} AND bm.amount_source <> 'override'
    RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM marked
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
