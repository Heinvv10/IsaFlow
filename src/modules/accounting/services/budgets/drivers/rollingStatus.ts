/**
 * What the versions bar shows for a version (Budgets P4 spec §5, §6): "Rolled through <month> · N
 * closed since", "<month> reopened after the roll", and the actuals the forecast cannot place.
 * Read-only; nothing here is stored (no migration): every figure is recomputed from committed state.
 *
 * - staleMonths (rolling versions): closed months after rolled_through_month (a roll that did not
 *   run). Turning auto-roll on stamps nothing, so every closed month is stale until a roll.
 * - reopenedMonths (any version): months that hold 'actual' cells and are not closed now (reopened
 *   since those actuals were written; the next roll, or Roll now, makes them 'manual').
 * - unplaced: the planner's own rule (`unplacedActuals`, reforecast.ts) over the version's rows as
 *   the roll reads them (`loadVersionModel`) and the closed months' actuals (`readClosedActuals`),
 *   named as a create or roll names them, so an auto roll's unplaced amounts stay visible even when
 *   the roll changed no cell.
 */
import { sql, type DbRow } from '@/lib/neon';
import { versionYear } from '../budgetVersionScope';
import { budgetMonthKeysInWindow } from '../../reports/budgetPeriodWindow';
import { loadVersionModel } from './driverModel';
import { listDriverLines } from './driverRepository';
import { unplacedActuals } from './reforecast';
import { closedMonthsOf, describeUnplaced, readClosedActuals, type UnplacedActualLine } from './reforecastInputs';
import { rollingRow } from './rollingForecastService';

export interface RollingStatus {
  rolling: boolean;
  /** 'YYYY-MM' months. */
  rolledThroughMonth: string | null;
  latestClosedMonth: string | null;
  /** Closed months after rolledThroughMonth (every closed month when never rolled); [] for a version that does not roll. */
  staleMonths: string[];
  /** Months holding 'actual' cells that are not closed now. */
  reopenedMonths: string[];
  /** Closed-month actuals the version cannot place, named, in rand. */
  unplaced: UnplacedActualLine[];
  lastRolledAt: string | null;
  lastError: string | null;
}

/** Another company's version is a 404. Sequential reads (withAuth binds one client). */
export async function rollingStatus(companyId: string, versionId: string): Promise<RollingStatus> {
  const id = versionId.toLowerCase();
  const year = await versionYear(companyId, id);
  const row = await rollingRow(companyId, id);
  const months = budgetMonthKeysInWindow(year.startDate, year.endDate);
  const closed = await closedMonthsOf(companyId, year, months);
  const closedSet = new Set(closed);
  const through = row?.rolledThrough ?? null;
  const actualMonths = (await sql`
    SELECT DISTINCT to_char(month, 'YYYY-MM') AS m FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${id}::UUID AND amount_source = 'actual'
     ORDER BY 1
  `) as DbRow[];
  const read = await readClosedActuals(companyId, year, closed);
  const model = await loadVersionModel(companyId, id, months, await listDriverLines(companyId, id));
  const unplaced = describeUnplaced(
    { rows: model.rows, unplaced: unplacedActuals({ months, rows: model.rows, actuals: read.actuals, closedMonths: closedSet }) }, read);
  return {
    rolling: row !== null,
    rolledThroughMonth: through,
    latestClosedMonth: closed.length > 0 ? closed[closed.length - 1]! : null,
    staleMonths: row ? closed.filter((m) => through === null || m > through) : [],
    reopenedMonths: actualMonths.map((r) => String(r.m)).filter((m) => !closedSet.has(m)),
    unplaced,
    lastRolledAt: row?.lastRolledAt ?? null,
    lastError: row?.lastError ?? null,
  };
}
