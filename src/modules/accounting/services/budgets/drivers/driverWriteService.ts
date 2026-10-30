/**
 * Driver writes (P4 spec §1.1, §1.2, §5): set or replace a row's driver, delete it, reset a row's
 * overrides, refresh headcount. Each runs in `runDriverWrite` (the version compare-and-set on the
 * client's token first, one savepoint, recompute, one audit row) and answers the version's new
 * token with the recompute's count.
 *
 * - Save: the line's kind columns (`normaliseLine`), its months inside the version
 *   (`assertDriverMonths`), what it names (`checkDriverLine`), then a cycle check over EVERY stored
 *   driver of the version (skipped ones included, `fullDriverGraph`) with this one substituted:
 *   a loop through THIS row is 400 DRIVER_CYCLE with the path, and nothing is written. A loop
 *   stored elsewhere does not block it (it stays skipped, with its warning). The row's 'driver' cells outside the new range go back to 'manual' (the
 *   engine's re-sourcing, in the recompute); an 'override' outside it stays (spec §1.2).
 * - Delete: the row's 'override' cells become 'manual' here, its 'driver' cells in the recompute;
 *   values kept.
 * - Reset: 'override' cells (one month, or the whole row) back to 'driver', then recomputed.
 * - Refresh headcount: a recompute with every per_head row live (payroll never pushes one). A
 *   driver save or reset reads headcount for its own row only; every other pass keeps per_head rows
 *   as they stand. Each write that reads payroll audits and answers `headcountAsOf`.
 */
import { versionYear } from '../budgetVersionScope';
import { inputError } from '../gridErrors';
import { assertDriverMonths, monthIndex } from './driverEngine';
import { normaliseLine, rowKeyOfGrain, toDriverDef, type DriverGrain, type DriverLineInput, type StoredDriverLine } from './driverLine';
import { deleteDriverLine, driverLineOfRow, listDriverLines, upsertDriverLine } from './driverRepository';
import { releaseOverrideCells, resetOverrideCells } from './driverCellSources';
import { cycleThrough, fullDriverGraph, loadVersionModel, rowLabel } from './driverModel';
import { checkDriverLine } from './driverValidate';
import { BudgetDriverError } from './driverErrors';
import { runDriverWrite, type DriverWriteTarget } from './driverWriteScope';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const lowerGrain = (g: DriverGrain): DriverGrain => ({
  glAccountId: g.glAccountId.toLowerCase(), cc1Id: g.cc1Id?.toLowerCase() ?? null,
  cc2Id: g.cc2Id?.toLowerCase() ?? null, buId: g.buId?.toLowerCase() ?? null,
});

/** The version's drivers; another company's version is BUDGET_VERSION_NOT_FOUND. */
export async function listDrivers(companyId: string, versionId: string): Promise<{ drivers: StoredDriverLine[] }> {
  await versionYear(companyId, versionId);
  return { drivers: await listDriverLines(companyId, versionId.toLowerCase()) };
}

export async function saveDriver(companyId: string, userId: string, target: DriverWriteTarget, input: DriverLineInput) {
  const line = normaliseLine(input);
  const key = rowKeyOfGrain(line);
  return runDriverWrite(companyId, userId, target, 'driver_saved', async (ctx) => {
    assertDriverMonths(monthIndex(ctx.months), toDriverDef(line));
    const others = (await listDriverLines(companyId, ctx.versionId)).filter((d) => rowKeyOfGrain(d) !== key);
    await checkDriverLine(companyId, ctx.versionId, line, others);
    const model = await loadVersionModel(companyId, ctx.versionId, ctx.months, [...others, line]);
    // checkDriverLine and assertDriverMonths refuse most of what the model would skip; the model alone
    // refuses a read at a grain its account is not budgeted at (it would put the account at two grains).
    const unplaced = model.skipped.find((x) => x.rowKey === key);
    if (unplaced) throw new BudgetDriverError('DRIVER_REF', unplaced.message);
    // Over EVERY stored driver, skipped ones too: a loop through one comes back with its account.
    const loop = cycleThrough(fullDriverGraph(model), key);
    if (loop) {
      throw new BudgetDriverError('DRIVER_CYCLE', `This driver makes a loop: ${loop.map((k) => rowLabel(k, model.labels)).join(' → ')}`, loop);
    }
    const { line: driver, replaced } = await upsertDriverLine(companyId, ctx.versionId, userId, line);
    return { value: { driver }, audit: { kind: line.kind, rowKey: key, replaced: String(replaced) }, live: new Set([key]) };
  });
}

export async function deleteDriver(companyId: string, userId: string, target: DriverWriteTarget, driverId: string) {
  return runDriverWrite(companyId, userId, target, 'driver_deleted', async (ctx) => {
    const gone = await deleteDriverLine(companyId, ctx.versionId, driverId.toLowerCase());
    if (!gone) throw new BudgetDriverError('DRIVER_NOT_FOUND', 'Budget driver not found in this version');
    const released = await releaseOverrideCells(companyId, ctx.versionId, gone);
    return {
      value: { deleted: true as const, id: gone.id },
      audit: { kind: gone.kind, rowKey: rowKeyOfGrain(gone), releasedOverrides: String(released) },
    };
  });
}

export interface ResetOverrideInput extends DriverGrain {
  /** 'YYYY-MM': one cell; null: every override cell of the row. */
  month: string | null;
}

export async function resetOverride(companyId: string, userId: string, target: DriverWriteTarget, input: ResetOverrideInput) {
  const g = lowerGrain(input);
  const { month } = input;
  if (month !== null && !MONTH.test(month)) throw inputError(`${JSON.stringify(month)} is not a month (YYYY-MM)`);
  return runDriverWrite(companyId, userId, target, 'override_reset', async (ctx) => {
    const driver = await driverLineOfRow(companyId, ctx.versionId, g);
    if (!driver) throw inputError('This row has no driver to reset to');
    if (month !== null && (month < driver.fromMonth || month > driver.toMonth)) {
      throw inputError(`Month ${month} is outside the driver's months (${driver.fromMonth} to ${driver.toMonth})`);
    }
    const reset = await resetOverrideCells(companyId, ctx.versionId, g, driver, month);
    return {
      value: { reset },
      audit: { rowKey: rowKeyOfGrain(g), resetCells: String(reset), ...(month === null ? {} : { month }) },
      live: new Set([rowKeyOfGrain(g)]),
    };
  });
}

export async function refreshHeadcount(companyId: string, userId: string, target: DriverWriteTarget) {
  // The recompute's payroll read time wins; this one stands when the version has no per_head row.
  const requestedAt = new Date().toISOString();
  return runDriverWrite(companyId, userId, target, 'headcount_refresh', async () => ({
    value: {}, audit: { headcountAsOf: requestedAt }, live: 'all' as const,
  }));
}
