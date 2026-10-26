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
 */
import { sql, type DbRow } from '@/lib/neon';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { toCents } from './grid/cents';
import type { SaveCell, ValidatedBatch } from './gridSaveValidate';

/** Stands in for "no dimension" in the match keys only; never written. */
const NIL = '00000000-0000-0000-0000-000000000000';

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

/** Sets each cell's amount: an existing cell is updated (when it changes), a new one inserted. */
export async function writeCells(companyId: string, versionId: string, userId: string, cells: ValidatedBatch['upserts']): Promise<void> {
  if (cells.length === 0) return;
  const k = keyArrays(cells);
  // Whole cents travel as integers and are divided in NUMERIC, so no float reaches the column.
  const cents = cells.map((c) => toCents(c.amount));
  await sql`
    UPDATE budget_month_amounts bm SET amount = t.cents::NUMERIC / 100
      FROM unnest(${k.a}::UUID[], ${k.c1}::UUID[], ${k.c2}::UUID[], ${k.b}::UUID[], ${k.m}::DATE[], ${cents}::BIGINT[])
           AS t(a, c1, c2, b, m, cents)
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
       AND bm.gl_account_id = t.a AND bm.month = t.m AND COALESCE(bm.cc1_id, ${NIL}::UUID) = t.c1
       AND COALESCE(bm.cc2_id, ${NIL}::UUID) = t.c2 AND COALESCE(bm.bu_id, ${NIL}::UUID) = t.b
       AND bm.amount <> t.cents::NUMERIC / 100
  `;
  // The version row is locked, so no other writer adds one of these cells in between; the
  // conflict clause stays as the backstop.
  await sql`
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
  `;
}
