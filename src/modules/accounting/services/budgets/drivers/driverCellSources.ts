/**
 * "Reset to driver" (P4 spec §1.2): a row's 'override' cells (one month, or every one of the row)
 * inside its driver's range become 'driver', values kept, so the recompute that follows rewrites
 * them. Run with the version locked. (Cells a driver no longer covers are re-sourced 'manual' by
 * the engine itself, in the recompute.)
 */
import { sql, type DbRow } from '@/lib/neon';
import { monthKeyToDate } from '../../reports/budgetPeriodWindow';
import type { DriverGrain } from './driverLine';

const rowSql = (companyId: string, versionId: string, g: DriverGrain) => sql`
  company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID AND gl_account_id = ${g.glAccountId}::UUID
  AND cc1_id IS NOT DISTINCT FROM ${g.cc1Id}::UUID AND cc2_id IS NOT DISTINCT FROM ${g.cc2Id}::UUID
  AND bu_id IS NOT DISTINCT FROM ${g.buId}::UUID`;

/** The row's override cells in [from, to] (or just `month`) back to 'driver'. Returns how many moved. */
export async function resetOverrideCells(
  companyId: string, versionId: string, g: DriverGrain, range: { fromMonth: string; toMonth: string }, month: string | null,
): Promise<number> {
  const only = month === null ? null : monthKeyToDate(month);
  const rows = (await sql`
    WITH moved AS (
      UPDATE budget_month_amounts SET amount_source = 'driver'
       WHERE ${rowSql(companyId, versionId, g)} AND amount_source = 'override'
         AND month BETWEEN ${monthKeyToDate(range.fromMonth)}::DATE AND ${monthKeyToDate(range.toMonth)}::DATE
         AND (${only}::DATE IS NULL OR month = ${only}::DATE)
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM moved
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
