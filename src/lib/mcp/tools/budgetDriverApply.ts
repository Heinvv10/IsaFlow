/**
 * Runs set_budget_drivers' changes (budget tools PR 3) through the services the app's driver routes call, in
 * order, as the token user, each with the token the previous one left (runDriverWrite compares-and-sets it,
 * then bumps it). A service refusal (a driver refusal, a budget version refusal: locked, stale, a holder slice,
 * the bounded row lock) becomes `DriverChangeRefused` naming the change and its position; anything else is
 * rethrown unchanged.
 */
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { deleteDriver, refreshHeadcount, resetOverride, saveDriver } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { createHire, deleteHire, updateHire } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { driverRefusal } from '@/modules/accounting/services/budgets/drivers/driverErrors';
import type { DriverWriteOutcome, DriverWriteTarget } from '@/modules/accounting/services/budgets/drivers/driverWriteScope';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import type { McpToolContext } from '../types';
import type { DriverChange } from './budgetDriverArgs';

/** At most this many recompute warnings are listed per change (the rest are counted). */
const MAX_WARNINGS_LISTED = 20;

export class DriverChangeRefused extends Error {
  constructor(readonly change: DriverChange, readonly position: number, message: string) {
    super(message);
    this.name = 'DriverChangeRefused';
  }
}

function runChange(ctx: McpToolContext, target: DriverWriteTarget, c: DriverChange): Promise<DriverWriteOutcome> {
  const { companyId, userId } = ctx;
  switch (c.op) {
    case 'set_driver': return saveDriver(companyId, userId, target, c.line);
    case 'delete_driver': return deleteDriver(companyId, userId, target, c.driverId);
    case 'reset_override': return resetOverride(companyId, userId, target, { ...c.grain, month: c.month });
    case 'add_hire': return createHire(companyId, userId, target, c.hire);
    case 'update_hire': return updateHire(companyId, userId, target, c.hireId, c.hire);
    case 'delete_hire': return deleteHire(companyId, userId, target, c.hireId);
    case 'refresh_headcount': return refreshHeadcount(companyId, userId, target);
  }
}

const refusalOf = (err: unknown): Error | null =>
  driverRefusal(err) ?? (err instanceof BudgetVersionError || err instanceof RowLockTimeoutError ? err : null);

export async function applyDriverChanges(ctx: McpToolContext, versionId: string, token: string, changes: readonly DriverChange[]) {
  let current = token;
  const outcomes: Array<Record<string, unknown>> = [];
  for (const [position, c] of changes.entries()) {
    let out: DriverWriteOutcome;
    try {
      out = await runChange(ctx, { versionId, expectedUpdatedAt: current }, c);
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) throw new DriverChangeRefused(c, position, refusal.message);
      throw err;
    }
    current = out.updatedAt;
    outcomes.push({
      i: c.index, op: c.op, recomputed: out.recomputed,
      ...(out.warnings.length > 0 ? { warnings: out.warnings.slice(0, MAX_WARNINGS_LISTED).map((w) => ({ code: w.code, message: w.message })), warnings_total: out.warnings.length } : {}),
      ...(out.headcountAsOf ? { headcount_as_of: out.headcountAsOf } : {}),
      ...(out.frozenDriverCells ? { frozen_driver_cells: out.frozenDriverCells.cells } : {}),
    });
  }
  return { token: current, outcomes };
}
