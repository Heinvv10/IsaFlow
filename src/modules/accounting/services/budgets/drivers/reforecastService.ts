/**
 * "New reforecast from actuals" (Budgets P4 spec §5): a draft `kind='reforecast'` version in the
 * source's year, based on the source, whose closed months hold the actuals at each row's grain and
 * whose open months keep the source's cells and sources; the source's drivers and planned hires
 * are copied and recomputed over the result (`planReforecast`). Optionally rolling (§6): one per
 * company and year.
 *
 * In one savepoint (withAuth COMMITs a 4xx, so a refusal after the version was inserted, a second
 * rolling forecast for the year say, must take the version with it):
 *   holdYearRegistry → the source row FOR SHARE (404 for another company's; a locked source is only
 *   read, and the share lock keeps its writers out until this commits) → createVersion (draft,
 *   based_on = source; its own audit row) → lockVersionForWrite on the new version → drivers, hires
 *   and the cells of accounts the grid does not show copied as they are → closed months → actuals
 *   (P3's reader) → plan (headcount refreshed, nothing frozen) → cells written with their source
 *   (an 'actual' cell, 0 when none, for EVERY row in every closed month: PR-3's recompute reads a
 *   month holding an 'actual' as closed) → the rolling row → one audit row (source, closed months,
 *   cells, unplaced, headcountAsOf).
 * Untagged actuals on an account budgeted by a dimension are never dropped: they are returned as
 * `unplaced`, named (spec §5, §11: payroll's labour lines carry no CC1).
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { RowLockTimeoutError, withRowLockBudget } from '../../core/rowLockBudget';
import { auditBudgetWrite, holdYearRegistry, lockVersionForWrite } from '../budgetVersionScope';
import { createVersion, getVersion, type VersionActor } from '../budgetVersions';
import { BudgetVersionError, mapBudgetDbError, type BudgetVersion } from '../budgetVersionTypes';
import { fromCents } from '../grid/cents';
import { loadVersionModel } from './driverModel';
import type { RecomputeWarning } from './driverRecomputeService';
import { listDriverLines } from './driverRepository';
import {
  closedMonthsOf, describeUnplaced, planOver, readClosedActuals, reforecastYear, writePlannedCells, type UnplacedActualLine,
} from './reforecastInputs';

export interface ReforecastCreated {
  version: BudgetVersion;
  rolling: boolean;
  closedMonths: string[];
  /** Cells written. */
  cells: number;
  unplaced: UnplacedActualLine[];
  warnings: RecomputeWarning[];
  /** When payroll was read for per_head drivers (headcount refreshed); null when none needed it. */
  headcountAsOf: string | null;
}

/** The source row, share-locked (bounded wait); another company's is BUDGET_VERSION_NOT_FOUND. */
async function holdSource(companyId: string, sourceId: string): Promise<{ fiscalYear: number }> {
  const rows = (await withRowLockBudget(
    () => sql`SELECT fiscal_year FROM budget_versions WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID FOR SHARE`,
    () => new RowLockTimeoutError('The source budget version'),
  )) as DbRow[];
  if (!rows[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  return { fiscalYear: Number(rows[0].fiscal_year) };
}

/** Driver lines, planned hires and the non-P&L cells of the source, as they are, into `versionId`. Granted columns only. */
async function copyInputs(companyId: string, sourceId: string, versionId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO budget_driver_lines (
      company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month, to_month, amount, pct,
      ref_gl_account_id, ref_cc1_id, ref_cc2_id, ref_bu_id, ref_section, ref_scope, base_month, headcount_cost_centre_id,
      rounding_unit, created_by)
    SELECT company_id, ${versionId}::UUID, gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month, to_month, amount, pct,
           ref_gl_account_id, ref_cc1_id, ref_cc2_id, ref_bu_id, ref_section, ref_scope, base_month, headcount_cost_centre_id,
           rounding_unit, ${userId}
      FROM budget_driver_lines WHERE company_id = ${companyId}::UUID AND version_id = ${sourceId}::UUID
  `;
  await sql`
    INSERT INTO budget_planned_hires (company_id, version_id, label, cost_centre_id, start_month, end_month, fte, created_by)
    SELECT company_id, ${versionId}::UUID, label, cost_centre_id, start_month, end_month, fte, ${userId}
      FROM budget_planned_hires WHERE company_id = ${companyId}::UUID AND version_id = ${sourceId}::UUID
  `;
  // Cells on accounts that are not revenue or expense are no rows of the engine (or the grid): kept as the source holds them.
  await sql`
    INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, amount_source, created_by)
    SELECT bm.company_id, ${versionId}::UUID, bm.gl_account_id, bm.cc1_id, bm.cc2_id, bm.bu_id, bm.month, bm.amount, bm.amount_source, ${userId}
      FROM budget_month_amounts bm
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${sourceId}::UUID AND ga.account_type NOT IN ('revenue', 'expense')
  `;
}

/** The rolling row for a new reforecast; a year that already rolls one is a 409 naming it. */
export async function insertRollingRow(companyId: string, fiscalYear: number, versionId: string, userId: string): Promise<void> {
  const made = (await sql`
    INSERT INTO budget_rolling_forecasts (company_id, fiscal_year, version_id, created_by)
    VALUES (${companyId}::UUID, ${fiscalYear}, ${versionId}::UUID, ${userId})
    ON CONFLICT DO NOTHING
    RETURNING version_id
  `) as DbRow[];
  if (made[0]) return;
  const other = (await sql`
    SELECT v.name FROM budget_rolling_forecasts r JOIN budget_versions v ON v.id = r.version_id AND v.company_id = r.company_id
     WHERE r.company_id = ${companyId}::UUID AND r.fiscal_year = ${fiscalYear}
  `) as DbRow[];
  throw new BudgetVersionError('BUDGET_VERSION_STATE', other[0]
    ? `FY${fiscalYear} already has a rolling forecast ('${String(other[0].name)}'); turn its auto-roll off first`
    : `FY${fiscalYear} already has a rolling forecast`);
}

export async function createReforecastFromActuals(
  companyId: string, actor: VersionActor, sourceVersionId: string, input: { name: unknown; rolling: boolean },
): Promise<ReforecastCreated> {
  const sourceId = sourceVersionId.toLowerCase();
  await holdYearRegistry(companyId);
  try {
    return await withSavepoint('budget_reforecast_create', async () => {
      const { fiscalYear } = await holdSource(companyId, sourceId);
      const created = await createVersion(companyId, { fiscalYear, name: input.name, kind: 'reforecast' }, actor, sourceId);
      const id = created.id;
      await lockVersionForWrite(companyId, id);
      await copyInputs(companyId, sourceId, id, actor.userId);

      const { year, months } = await reforecastYear(companyId, fiscalYear);
      const closed = await closedMonthsOf(companyId, year, months);
      const read = await readClosedActuals(companyId, year, closed);
      const model = await loadVersionModel(companyId, sourceId, months, await listDriverLines(companyId, sourceId));
      const { plan, headcountAsOf, warnings } = await planOver(companyId, model, id, closed, read);
      const cells = await writePlannedCells(companyId, id, actor.userId, plan.cells);
      if (input.rolling) await insertRollingRow(companyId, fiscalYear, id, actor.userId);

      const unplaced = describeUnplaced(plan, read);
      await auditBudgetWrite(companyId, actor.userId, 'update', id, fiscalYear, {
        reforecastFrom: sourceId, closedMonths: closed.join(',') || 'none', cells: String(cells),
        unplaced: String(unplaced.length), unplacedTotal: String(fromCents(plan.unplaced.reduce((s, u) => s + u.amount, 0))),
        rolling: String(input.rolling), headcountAsOf: headcountAsOf ?? 'none',
      });
      log.info('Created budget reforecast from actuals', {
        companyId, sourceId, versionId: id, closedMonths: closed.length, cells, unplaced: unplaced.length,
      }, 'accounting');
      return {
        version: await getVersion(companyId, id), rolling: input.rolling, closedMonths: closed, cells, unplaced, warnings, headcountAsOf,
      };
    });
  } catch (err) {
    return mapBudgetDbError(err);
  }
}
